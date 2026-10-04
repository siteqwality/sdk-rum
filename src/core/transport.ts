// The batch queue for `POST /v2/batch` (design 6.3): gzip on the wire while the page lives, an
// uncompressed keepalive tail on pagehide, one request in flight, backoff, hidden spacing.
import type { SqEvent } from '../types';
import { VERSION } from '../version';
import { send, gzip, isRefused, Backoff, keepaliveFits, KEEPALIVE_MAX_BYTES, type SendOutcome } from './send';
import { now, isHidden, byteLength } from './util';

export const FLUSH_INTERVAL_MS = 10_000;
/** Errors reach the intake within this (design 8.1). */
export const URGENT_FLUSH_MS = 1_000;
export const MAX_BATCH_EVENTS = 500;
/** Uncompressed body per request, under the intake's 1 MB wire limit even without gzip. */
export const MAX_BATCH_CHARS = 900_000;
export const MAX_QUEUED = 1_000;
/** Events kept while consent is pending (design 7.2). */
export const MAX_PENDING = 200;
/** Sends while hidden are spaced this far apart (the 2026-10-03 hidden-tab loop). */
export const HIDDEN_SPACING_MS = 5_000;
const FLUSH_AT = 200;
const GZIP_FROM_CHARS = 1_024;

/** The batch ctx; `session_id` and `page_load_id` key which events may share a batch. */
export interface Ctx {
  session_id: string;
  page_load_id: string;
  [field: string]: unknown;
}

interface Entry {
  e: SqEvent;
  c: Ctx;
}

export interface TransportOptions {
  url: string;
  token: string;
  fetch: typeof fetch;
  /** A drop counter (`status` counters). */
  count: (name: string, n?: number) => void;
  /** Debug logging of each outcome. */
  log?: (outcome: SendOutcome, events: number) => void;
  /** 401 or 403: nothing more is accepted from this page. */
  onStop?: () => void;
}

export type Transport = ReturnType<typeof createTransport>;

export function createTransport(o: TransportOptions) {
  let queue: Entry[] = [];
  let held = false;
  let stopped = false;
  // Over the request budget: nothing is kept or sent until block(false).
  let blocked = false;
  let unloading = false;
  let inFlight = 0;
  let lastSend = -Infinity;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let urgentTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let unloadQueued = false;
  // An urgent event (an error) is queued: send as soon as the request in flight settles.
  let urgentQueued = false;
  const backoff = new Backoff();

  const interval = setInterval(() => flush(), FLUSH_INTERVAL_MS);

  function trim(): void {
    const cap = held ? MAX_PENDING : MAX_QUEUED;
    if (queue.length > cap) {
      o.count('queue_overflow', queue.length - cap);
      queue.splice(0, queue.length - cap);
    }
  }

  /** The next batch: leading entries of one session and page load, within the caps. */
  function take(maxChars = MAX_BATCH_CHARS): { entries: Entry[]; json: string } {
    const first = queue[0].c;
    const parts: string[] = [];
    let chars = 0;
    let n = 0;
    while (n < queue.length && n < MAX_BATCH_EVENTS) {
      const { e, c } = queue[n];
      if (c.session_id !== first.session_id || c.page_load_id !== first.page_load_id) break;
      let s: string;
      try {
        s = JSON.stringify(e);
      } catch {
        s = '';
      }
      if (n > 0 && chars + s.length > maxChars) break;
      if (s) parts.push(s);
      chars += s.length + 1;
      n++;
    }
    const entries = queue.splice(0, n);
    if (!queue.length) urgentQueued = false;
    const ctx = entries[entries.length - 1].c;
    const json = `{"v":2,"sent_at":${now()},"sdk":${JSON.stringify(VERSION)},"ctx":${JSON.stringify(ctx)},"events":[${parts.join(',')}]}`;
    return { entries, json };
  }

  function settle(entries: Entry[], outcome: SendOutcome): void {
    o.log?.(outcome, entries.length);
    if (stopped || blocked) return;
    if (outcome.kind === 'retryable') {
      queue.unshift(...entries);
      trim();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        flush();
      }, backoff.next(outcome.retryAfterMs));
      return;
    }
    if (isRefused(outcome)) {
      stop();
      o.onStop?.();
      return;
    }
    if (outcome.kind === 'ok') {
      backoff.reset();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    } else o.count('rejected_batch');
    if (queue.length && (isHidden() ? scheduleHidden() : queue.length >= FLUSH_AT || urgentQueued)) flush();
  }

  async function sendOne(): Promise<void> {
    const { entries, json } = take();
    inFlight++;
    lastSend = now();
    let body: string | Blob = json;
    let type = 'application/json';
    let size = byteLength(json);
    if (json.length >= GZIP_FROM_CHARS) {
      const zipped = await gzip(json);
      if (zipped) {
        body = zipped;
        type = 'application/octet-stream';
        size = zipped.size;
      }
    }
    const outcome = await send(o.fetch, o.url, o.token, body, type, size);
    inFlight--;
    settle(entries, outcome);
  }

  /** Sends the next batch unless one is in flight, a retry is pending or consent is pending. */
  function flush(): void {
    if (stopped || blocked || held || unloading || !queue.length || inFlight || retryTimer) return;
    if (isHidden() && now() < lastSend + HIDDEN_SPACING_MS) {
      scheduleHidden();
      return;
    }
    void sendOne();
  }

  /** One spaced send while hidden. Returns false: the timer sends. */
  function scheduleHidden(): false {
    if (!hiddenTimer && !stopped) {
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        flush();
      }, Math.max(0, lastSend + HIDDEN_SPACING_MS - now()));
    }
    return false;
  }

  /** pagehide: everything queued goes now, uncompressed and keepalive, within the budget. */
  function sendTail(): void {
    unloadQueued = false;
    if (stopped || blocked || held) return;
    let max = KEEPALIVE_MAX_BYTES - 5_000;
    while (queue.length) {
      const { entries, json } = take(max);
      const size = byteLength(json);
      if (size > KEEPALIVE_MAX_BYTES) {
        if (entries.length > 1) queue.unshift(...entries);
        else o.count('oversized_tail');
        max /= 2;
        continue;
      }
      if (!keepaliveFits(size)) {
        // The keepalive budget is spent: what it cannot carry is dropped and counted.
        o.count('oversized_tail', entries.length + queue.length);
        queue = [];
        return;
      }
      lastSend = now();
      void send(o.fetch, o.url, o.token, json, 'application/json', size).then((r) => o.log?.(r, entries.length));
    }
  }

  function stop(): void {
    stopped = true;
    queue = [];
    clearInterval(interval);
    for (const t of [retryTimer, urgentTimer, hiddenTimer]) if (t) clearTimeout(t);
  }

  return {
    push(e: SqEvent, c: Ctx, urgent = false): void {
      if (stopped || blocked) return;
      queue.push({ e, c });
      trim();
      if (unloading) {
        if (!unloadQueued) {
          unloadQueued = true;
          void Promise.resolve().then(sendTail);
        }
      } else if (isHidden()) scheduleHidden();
      else if (queue.length >= FLUSH_AT) flush();
      else if (urgent) {
        urgentQueued = true;
        urgentTimer ||= setTimeout(() => {
          urgentTimer = null;
          flush();
        }, URGENT_FLUSH_MS);
      }
    },
    flush,
    /** Tab hidden: send everything now, compressed; the page is still alive. */
    hide(): void {
      if (stopped || blocked || held || unloading) return;
      const backingOff = retryTimer !== null;
      while (queue.length) {
        void sendOne();
        if (backingOff) break;
      }
    },
    unload(): void {
      unloading = true;
      sendTail();
    },
    restore(): void {
      unloading = false;
    },
    /** Consent pending: keep at most MAX_PENDING events and send nothing. */
    hold(on: boolean): void {
      held = on;
      trim();
      if (!on) flush();
    },
    /** Re-keys held events to the session adopted when consent was granted. */
    rekey(c: Ctx): void {
      for (const entry of queue) entry.c = c;
    },
    clear(): void {
      queue = [];
    },
    /** The request budget is spent: drop everything and send nothing until a new session. */
    block(on: boolean): void {
      blocked = on;
      if (!on) return;
      queue = [];
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
    stop,
    get stopped() {
      return stopped;
    },
    get size() {
      return queue.length;
    },
  };
}
