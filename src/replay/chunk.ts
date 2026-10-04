// The lazy replay chunk (design 5.2): rrweb, the segmenter and its transport. SDK 2.0.0 sends
// segments to /v1/segments; WP 2.1 adds the replay ring, gzip and /v2/segments behind this API.
import { record } from '@rrweb/record';
import { ReplayRecorder, replayPrivacy, type ReplayState } from './recorder';
import { ReplayTransport } from './transport';
import type { SeqStore } from './sequence';
import { LEASE_KEY, LEASE_TTL_MS, BEAT_MS, WRITE_MS, TAKEOVER_MS, POLL_MS, storageKv, cookieKv, type Kv } from './lease';
import type { UrlSanitizer } from '../core/url';
import type { send } from '../core/send';
import { isHidden, byteLength } from '../core/util';
import { createBudget, budgetError, REPLAY_KEY, REPLAY_LIMITS } from '../core/budget';
import type { SdkConfig } from '../types';

export interface ReplayStartOptions {
  /** 'stream' records and sends; 2.1 adds 'buffer' (the 60 s ring flushed on a rule match). */
  mode: 'stream';
  sessionId: string;
  windowId: string;
  /** Where the session lives: 'localStorage' when its tabs share it (one records at a time). */
  store: Exclude<SeqStore, Kv> | undefined;
  /** The session cookie's domain, when subdomains share the session: the lease lives there too. */
  cookieDomain?: string;
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

// Replay's own request budget, one per page load, so a replay cap never stops errors or views.
let kind: SeqStore | undefined;
const budget = createBudget(() => (kind === 'localStorage' || kind === 'sessionStorage' ? kind : undefined), REPLAY_KEY, REPLAY_LIMITS);

export function startReplay(o: ReplayStartOptions): ReplayHandle {
  kind = o.store;
  const recorder = new ReplayRecorder();
  const me = o.windowId;
  const ac = new AbortController();
  // Tabs that share the session share a lease: a cookie across subdomains, else localStorage.
  const kv: Kv | null = o.cookieDomain ? cookieKv(o.cookieDomain) : o.store === 'localStorage' ? storageKv('localStorage') : null;
  const shared = !!kv;
  const takeover = o.cookieDomain ? POLL_MS * 2 : TAKEOVER_MS;
  let core = o.paused ?? '';
  let away = false;
  let idle = false;
  let lastInput = o.now();
  let lastWrite = 0;
  let started = false;
  let claiming = false;
  let done = false;
  let claimTimer: ReturnType<typeof setTimeout> | undefined;
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // One live lease per session (`sid|window|beat`, `~` apart), so sessions never fight over one.
  function leases(): string[][] {
    return ((kv && kv.get(LEASE_KEY)) || '')
      .split('~')
      .map((l) => l.split('|'))
      .filter(([s, , at]) => s && o.now() - Number(at) < LEASE_TTL_MS);
  }
  function others(): string[][] {
    return leases().filter(([s]) => s !== o.sessionId);
  }
  function save(list: string[][]): boolean {
    return !!kv && kv.set(LEASE_KEY, list.map((l) => l.join('|')).join('~'));
  }
  function owner(): string {
    return leases().find(([s]) => s === o.sessionId)?.[1] ?? '';
  }
  function write(): boolean {
    lastWrite = o.now();
    return save([[o.sessionId, me, String(lastWrite)], ...others()]);
  }
  function release(): void {
    if (shared && owner() === me) save(others());
  }

  // Stopped for good: no listener, timer or lease outlives the recording.
  function teardown(): void {
    done = true;
    ac.abort();
    clearTimeout(claimTimer);
    timers.forEach(clearInterval);
    release();
  }
  const handle: ReplayHandle = {
    stop(discard) {
      teardown();
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
      onStatus: (state, why) => {
        if (state === 'stopped') teardown();
        o.onStatus(state, why);
      },
      now: o.now,
      store: kv ?? o.store ?? 'memory',
      paused: why || undefined,
    });
  }

  // This tab takes over: paused until the lease is still its own a moment later, so the tab it
  // takes over from stops first. The owner only refreshes its lease, at most every 5 s.
  function claim(): void {
    if (!shared || done || isHidden()) return;
    if (owner() === me) return void (o.now() - lastWrite >= WRITE_MS && write());
    // Without storage there is no lease to share: record alone.
    if (!write()) return ((away = false), apply());
    away = claiming = true;
    clearTimeout(claimTimer);
    claimTimer = setTimeout(check, takeover);
    apply();
  }
  function check(): void {
    claiming = false;
    const w = owner();
    if (!w && !isHidden()) return claim();
    away = !!w && w !== me;
    apply();
  }
  // Another tab took over: stop now. A freed lease goes to a visible tab.
  let seen: string | null = null;
  function leaseChanged(): void {
    const raw = kv && kv.get(LEASE_KEY);
    if (done || raw === seen) return;
    seen = raw;
    const w = owner();
    if (w && w !== me) (away = true), apply();
    else if (!w) claim();
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
  // Back from the back-forward cache: other tabs may own the session now.
  listen(window, 'pageshow', (e: PageTransitionEvent) => e.persisted && claim());
  timers.push(
    setInterval(() => {
      if (!idle && o.now() - lastInput >= o.idleMs) (idle = true), apply();
      if (!shared || isHidden()) return;
      const w = owner();
      if (w === me) write();
      else if (!w) claim();
      else if (!away) (away = true), apply();
    }, BEAT_MS),
  );

  if (!shared) apply();
  else {
    // A shared session records in one tab at a time: the visible, focused one.
    const w = owner();
    if (w && w !== me) {
      away = true;
      apply();
      if (document.hasFocus()) claim();
    } else claim();
    if (o.cookieDomain) timers.push(setInterval(leaseChanged, POLL_MS));
    else listen(window, 'storage', (e: StorageEvent) => e.key === LEASE_KEY && leaseChanged());
  }
  return handle;
}
