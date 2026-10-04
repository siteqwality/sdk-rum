// The lazy replay chunk (design 5.2): rrweb, the segmenter and its transport. SDK 2.0.0 sends
// segments to /v1/segments; WP 2.1 adds the replay ring, gzip and /v2/segments behind this API.
import { record } from '@rrweb/record';
import { ReplayRecorder, replayPrivacy, type ReplayState } from './recorder';
import { ReplayTransport } from './transport';
import type { SeqStore } from './sequence';
import type { UrlSanitizer } from '../core/url';
import type { send } from '../core/send';
import { storage, isHidden, byteLength } from '../core/util';
import { createBudget, budgetError, REPLAY_KEY, REPLAY_LIMITS } from '../core/budget';
import type { SdkConfig } from '../types';

export interface ReplayStartOptions {
  /** 'stream' records and sends; 2.1 adds 'buffer' (the 60 s ring flushed on a rule match). */
  mode: 'stream';
  sessionId: string;
  windowId: string;
  /** Where the session lives: 'localStorage' when its tabs share it (one records at a time). */
  store: SeqStore | undefined;
  replayBase: string;
  token: string;
  fetch: typeof fetch;
  /** The core's send, so the core and the chunk share one keepalive budget. */
  send: typeof send;
  url: UrlSanitizer;
  text: (s: string) => string;
  privacy: SdkConfig['privacy'];
  /** PII patterns masked with `*`. */
  mask: (s: string) => string;
  onStatus: (state: ReplayState, reason?: string) => void;
  /** The core's clock, so replay and RUM events share one tamper-proof time line. */
  now: () => number;
  /** No user input this long pauses recording (design 5.5: idle). */
  idleMs: number;
  /** The core's pause at start (privacy_url), if any; hidden and idle are the chunk's own. */
  paused?: string;
}

export interface ReplayHandle {
  /** `discard` drops the open segment and everything queued (consent, opt-out, budget). */
  stop(discard?: boolean): void;
  /** The core's pause (privacy_url); it holds alongside the chunk's own. */
  pause(reason: string): void;
  resume(): void;
}

import { LEASE_KEY, LEASE_TTL_MS, BEAT_MS, TAKEOVER_MS } from './lease';

// Replay's own request budget, one per page load, so a replay cap never stops errors or views.
let kind: SeqStore | undefined;
const budget = createBudget(() => (kind === 'memory' ? undefined : kind), REPLAY_KEY, REPLAY_LIMITS);

export function startReplay(o: ReplayStartOptions): ReplayHandle {
  kind = o.store;
  const recorder = new ReplayRecorder();
  const me = o.windowId;
  const ac = new AbortController();
  const shared = o.store === 'localStorage';
  let core = o.paused ?? '';
  let away = false;
  let idle = false;
  let lastInput = o.now();
  let started = false;
  let claiming = false;
  let done = false;
  let claimTimer: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;

  const handle: ReplayHandle = {
    stop(discard) {
      done = true;
      ac.abort();
      clearTimeout(claimTimer);
      clearInterval(beat);
      release();
      recorder.stop(discard);
      if (discard) transport.stop();
    },
    pause(reason) {
      core = reason;
      apply();
    },
    resume() {
      core = '';
      apply();
    },
  };
  // Past the budget: everything held is dropped and the core told, once.
  const over = () => {
    if (done) return;
    handle.stop(true);
    o.onStatus('stopped', 'replay_budget');
  };
  const transport = new ReplayTransport(
    `${o.replayBase}/v1/segments`,
    o.token,
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (!done && budget.take(o.sessionId, typeof body === 'string' ? byteLength(body) : 0)) return o.fetch(input, init);
      over();
      return Promise.reject(budgetError());
    }) as typeof fetch,
    o.send,
  );
  if (!budget.pageOpen()) {
    over();
    return handle;
  }

  const listen = (target: EventTarget, type: string, fn: (e: never) => void) => target.addEventListener(type, fn as EventListener, { signal: ac.signal });
  function owner(): string {
    const [s, w, at] = (storage.get('localStorage', LEASE_KEY) || '').split('|');
    return s === o.sessionId && o.now() - Number(at) < LEASE_TTL_MS ? w : '';
  }
  const write = () => storage.set('localStorage', LEASE_KEY, `${o.sessionId}|${me}|${o.now()}`);
  function release(): void {
    if (shared && owner() === me) storage.del('localStorage', LEASE_KEY);
  }

  function apply(): void {
    // Nothing starts while a claim is pending.
    if (done || (!started && claiming)) return;
    // Pauses stop rrweb and flush; the first to lift resumes from a full snapshot.
    const why = core || (isHidden() ? 'hidden' : idle ? 'idle' : away ? 'other_tab' : '');
    if (started) return why ? recorder.pause(why) : recorder.resume();
    started = true;
    recorder.start({
      sessionId: o.sessionId,
      record,
      onSegment: (segment) => void transport.sendSegment(o.sessionId, segment),
      privacy: replayPrivacy(o.privacy, o.mask),
      url: o.url,
      text: o.text,
      onStatus: o.onStatus,
      now: o.now,
      store: o.store ?? 'memory',
      paused: why || undefined,
    });
  }

  // This tab takes over; it records once the lease is still its own a moment later.
  function claim(): void {
    if (!shared || done || isHidden()) return;
    // Without storage there is no lease to share: record alone.
    if (owner() !== me && !write()) return ((away = false), apply());
    clearTimeout(claimTimer);
    claiming = true;
    claimTimer = setTimeout(check, TAKEOVER_MS);
  }
  function check(): void {
    claiming = false;
    const w = owner();
    if (!w && !isHidden()) return claim();
    away = !!w && w !== me;
    apply();
  }

  // Input, a visible tab and focus wake recording; pointer moves too, without claiming the lease.
  const wake = (claimIt: boolean) => {
    lastInput = o.now();
    if (claimIt) claim();
    if (idle) (idle = false), apply();
  };
  for (const type of ['focus', 'pointerdown', 'keydown', 'touchstart', 'scroll', 'pointermove']) listen(window, type, () => wake(!/move|scroll/.test(type)));
  listen(document, 'visibilitychange', () => {
    if (isHidden()) release();
    wake(true);
    apply();
  });
  listen(window, 'pagehide', release);
  beat = setInterval(() => {
    if (!idle && o.now() - lastInput >= o.idleMs) (idle = true), apply();
    const w = shared && owner();
    if (w === me) !isHidden() && write();
    else if (shared && !w) claim();
  }, BEAT_MS);

  if (!shared) apply();
  else {
    // A shared session records in one tab at a time: the visible, focused one.
    const w = owner();
    if (w && w !== me) {
      away = true;
      apply();
      if (document.hasFocus()) claim();
    } else claim();
    listen(window, 'storage', (e: StorageEvent) => {
      if (e.key !== LEASE_KEY || done) return;
      const now = owner();
      if (now && now !== me) {
        away = true;
        apply();
      } else if (!now) claim();
    });
  }
  return handle;
}
