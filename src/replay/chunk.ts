// The lazy replay chunk (design 5.2, 5.4, 5.5, 6.4): rrweb, the recorder diet, the replay ring
// and segments v2. Every tab records its own window; pauses while hidden, idle or on a
// never-record page; a request budget of its own.
import { record } from '@rrweb/record';
import { ReplayRecorder, replayPrivacy, type ReplayState } from './recorder';
import { ReplayTransport } from './transport';
import { streamFor } from './stream';
import type { UrlSanitizer } from '../core/url';
import type { send } from '../core/send';
import { isHidden, byteLength, storage } from '../core/util';
import { createBudget, budgetError, REPLAY_KEY, REPLAY_LIMITS } from '../core/budget';
import type { SdkConfig } from '../types';

/** What the chunk reads of the core's session: its id and window at start, the rest live. */
export interface ReplaySession {
  readonly id: string;
  readonly windowId: string;
  /** Renewed by a back-forward cache restore. */
  readonly pageLoadId: string;
  /** `r` on each segment names the rule that started replay. */
  readonly decision: { replay: boolean; rule_id?: string };
}

export interface ReplayStartOptions {
  /** Stream at once; false holds the last two checkouts in memory until go() (design 5.4). */
  live: boolean;
  session: ReplaySession;
  /** Where the session's counters live: shared by its tabs, this tab only, or memory. */
  store: 'localStorage' | 'sessionStorage' | undefined;
  replayBase: string;
  token: string;
  fetch: typeof fetch;
  /** The core's send, so the core and the chunk share one keepalive budget. */
  send: typeof send;
  url: UrlSanitizer;
  text: (s: string) => string;
  /** Privacy settings and the idle pause. */
  cfg: SdkConfig;
  /** PII patterns masked with `*`. */
  mask: (s: string) => string;
  onStatus: (state: ReplayState, reason?: string) => void;
  /** Drop counters for `status`. */
  count: (name: string, n?: number) => void;
  /** The core's clock, so replay and RUM events share one tamper-proof time line. */
  now: () => number;
  /** The core's pause at start (privacy_url), if any; hidden and idle are the chunk's own. */
  paused?: string;
  /** Called every 15 s while recording: the core stops replay when its session ended. */
  check: () => void;
}

export interface ReplayHandle {
  /** `discard` drops the open segment and everything queued (consent, opt-out, budget). */
  stop(discard?: boolean): void;
  /** The core's pause (privacy_url); it holds alongside the chunk's own. */
  pause(reason: string): void;
  resume(): void;
  /** A replay rule matched: what the ring holds goes out, then recording streams. */
  go(): void;
}

/** No user input this long pauses recording (design 5.5), within these bounds. */
const IDLE_DEFAULT_MS = 300_000;
const IDLE_MIN_MS = 60_000;
const IDLE_MAX_MS = 1_800_000;
const CHECK_MS = 15_000;

// Replay's own request budget, one per page load, so a replay cap never stops errors or views.
let kind: ReplayStartOptions['store'];
const budget = createBudget(() => kind, REPLAY_KEY, REPLAY_LIMITS);
let warned = false;

export function startReplay(o: ReplayStartOptions): ReplayHandle {
  kind = o.store;
  // The session this recording belongs to; the core restarts the chunk for another.
  const sid = o.session.id;
  const win = o.session.windowId;
  // 2.0.0 kept a lease and a segment counter shared by tabs; per-window streams need neither.
  for (const k of ['_sq_rl', '_sq_rseq']) storage.del('localStorage', k);
  const ac = new AbortController();
  const idleMs = Math.min(Math.max(o.cfg.limits.idle_pause_ms || IDLE_DEFAULT_MS, IDLE_MIN_MS), IDLE_MAX_MS);
  let core = o.paused ?? '';
  let idle = false;
  let lastInput = o.now();
  let done = false;
  let discarded = false;
  let unloading = false;
  let tail: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const recorder = new ReplayRecorder();
  const handle: ReplayHandle = {
    stop(discard) {
      if (discard) {
        discarded = true;
        transport.stop();
      }
      if (done) return;
      teardown();
      recorder.stop(discard);
    },
    pause(reason) {
      core = reason;
      apply();
    },
    resume() {
      core = '';
      apply();
    },
    go() {
      if (!done) recorder.go();
    },
  };

  // Stopped for good: no listener or timer outlives the recording.
  function teardown(): void {
    done = true;
    ac.abort();
    clearInterval(timer);
  }
  // Past the budget: everything held is dropped and the core told, once, if still recording.
  const fail = (reason: string) => {
    const live = !done;
    handle.stop(true);
    if (live) o.onStatus('stopped', reason);
  };
  const over = () => {
    if (discarded) return;
    o.count('replay_budget');
    if (!warned) console.warn('[SiteQwality RUM] Replay stopped: replay budget reached');
    warned = true;
    fail('replay_budget');
  };
  const transport = new ReplayTransport(
    o.replayBase,
    o.token,
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      // While the page unloads only keepalive outlives it; anything else is counted and dropped.
      if (unloading && !init?.keepalive) {
        o.count('replay_tail_dropped');
        return Promise.reject(budgetError());
      }
      if (!discarded && budget.take(sid, typeof body === 'string' ? byteLength(body) : body instanceof Blob ? body.size : 0)) return o.fetch(input, init);
      over();
      return Promise.reject(budgetError());
    }) as typeof fetch,
    o.send,
    {
      lost: () => recorder.resync(),
      tooLarge: () => fail('too_large'),
      refused: () => fail('refused'),
      count: o.count,
    },
  );
  if (!budget.pageOpen()) {
    over();
    return handle;
  }

  const stream = () => streamFor(sid, win, o.session.pageLoadId);
  const rule = () => {
    const d = o.session.decision;
    return d.replay ? d.rule_id : undefined;
  };
  const listen = (target: EventTarget, type: string, fn: (e: never) => void, capture = false) =>
    target.addEventListener(type, fn as EventListener, { signal: ac.signal, capture, passive: true });

  let started = false;
  function apply(): void {
    if (done) return;
    // Pauses stop rrweb and flush; the first to lift resumes from a full snapshot.
    const why = core || (isHidden() ? 'hidden' : idle ? 'idle' : '');
    if (started) return why ? recorder.pause(why) : recorder.resume();
    started = true;
    recorder.start({
      record,
      privacy: replayPrivacy(o.cfg.privacy, o.mask),
      url: o.url,
      text: o.text,
      now: o.now,
      stream,
      buffer: !o.live,
      onSegment: (segment, st) => void transport.push(st, segment, rule()),
      onStatus: (state, reason) => {
        if (state === 'stopped') teardown();
        o.onStatus(state, reason);
      },
      count: o.count,
      paused: why || undefined,
    });
  }

  // Input, a visible tab and focus wake recording, pointer moves too.
  const wake = () => {
    lastInput = o.now();
    if (idle) (idle = false), apply();
  };
  for (const type of ['focus', 'pointerdown', 'keydown', 'touchstart', 'scroll', 'pointermove']) listen(window, type, wake, true);
  listen(document, 'visibilitychange', () => {
    if (!isHidden()) wake();
    apply();
  });
  // pagehide: what cannot go is counted before the core reports its counters, and what can go
  // is sent after the core's own tail (capture listeners at the target run first).
  listen(
    window,
    'pagehide',
    () => {
      unloading = true;
      const t = recorder.unload();
      tail = transport.unload(t && { stream: t.stream, seg: t, rule: rule() });
    },
    true,
  );
  listen(window, 'pagehide', () => {
    tail?.();
    tail = null;
  });
  // Back from the back-forward cache, under a new page load id.
  listen(window, 'pageshow', (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    unloading = false;
    recorder.restore();
    apply();
  });
  timer = setInterval(() => {
    if (!idle && o.now() - lastInput >= idleMs) (idle = true), apply();
    o.check();
  }, CHECK_MS);

  apply();
  return handle;
}
