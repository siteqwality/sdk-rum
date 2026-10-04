// startReplay (design 5.4, 5.5, 6.4) with the real rrweb: per-window streams, the ring and go(),
// pauses, the request budget, pagehide and the back-forward cache.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { ReplayHandle, ReplayStartOptions } from '../src/replay/chunk';
import { createUrlSanitizer, createTextUrlSanitizer } from '../src/core/url';
import { normalizeConfig } from '../src/core/config';
import { REPLAY_LIMITS } from '../src/core/budget';
import { send } from '../src/core/send';
import { VERSION } from '../src/version';

const SID = '01a10521-0000-7000-8000-000000000001';
let startReplay: (o: ReplayStartOptions) => ReplayHandle;
let handle: ReplayHandle | null;
let sent: Array<{ q: Record<string, string>; events: Array<{ type: number; timestamp: number; data?: { tag?: string; payload?: unknown } }>; keepalive?: boolean; type: string }>;
let states: string[];
let counts: string[];
let pageLoad: string;
let decision: { replay: boolean; rule_id?: string };
let fetches: number;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: Date.now() });
  await import('@rrweb/record');
  ({ startReplay } = await import('../src/replay/chunk'));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<p id="p">hello</p>';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  sent = [];
  states = [];
  counts = [];
  fetches = 0;
  pageLoad = `pl-${Math.random()}`;
  decision = { replay: true, rule_id: 'r_1' };
});
afterEach(() => {
  handle?.stop(true);
  handle = null;
  vi.restoreAllMocks();
});

async function body(b: unknown): Promise<string> {
  if (typeof b === 'string') return b;
  return gunzipSync(Buffer.from(await (b as Blob).arrayBuffer())).toString('utf8');
}

const url = createUrlSanitizer();
function start(extra: Partial<ReplayStartOptions> = {}): ReplayHandle {
  handle = startReplay({
    live: true,
    sessionId: SID,
    windowId: 'w-1',
    pageLoadId: () => pageLoad,
    decision: () => decision,
    store: 'localStorage',
    replayBase: 'https://rp.test',
    token: 't',
    fetch: (async (u: string, init: RequestInit) => {
      fetches++;
      const q = Object.fromEntries(new URL(u).searchParams);
      sent.push({ q, events: JSON.parse(await body(init.body)), keepalive: init.keepalive, type: (init.headers as Record<string, string>)['Content-Type'] });
      return new Response('', { status: 202 });
    }) as unknown as typeof fetch,
    send,
    url,
    text: createTextUrlSanitizer(url),
    cfg: normalizeConfig(null, 'a'),
    mask: (s) => s,
    onStatus: (state, why) => states.push(why ?? state),
    count: (name) => counts.push(name),
    now: () => Date.now(),
    check: () => {},
    ...extra,
  });
  return handle;
}

/** Lets compression (real I/O) and the fake clock run. */
async function run(ms: number): Promise<void> {
  const until = Date.now() + ms;
  do {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(Math.min(50, Math.max(0, until - Date.now())));
  } while (Date.now() < until);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
async function mutate(text: string) {
  document.getElementById('p')!.textContent = text;
  await run(50);
}
function pagehide(persisted = false) {
  const e = new Event('pagehide') as PageTransitionEvent;
  Object.defineProperty(e, 'persisted', { value: persisted });
  window.dispatchEvent(e);
}
function pageshow() {
  const e = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(e, 'persisted', { value: true });
  window.dispatchEvent(e);
}
function visibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('startReplay', () => {
  it('streams this window\'s page load as segments v2: q from 0, the rule, the version', async () => {
    start();
    await mutate('one');
    await run(21_000);
    expect(sent.map((s) => s.q.q)).toEqual(['0', '1']);
    expect(sent[0].q).toMatchObject({ s: SID, w: 'w-1', p: pageLoad, fs: '1', r: 'r_1', v: VERSION });
    expect(sent[0].type).toBe('application/octet-stream');
    expect(sent[0].events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
    expect(states).toEqual(['recording']);
  });

  it('buffers without a match, sends nothing, and streams the ring on go()', async () => {
    decision = { replay: false };
    start({ live: false });
    expect(states).toEqual(['buffering']);
    for (let i = 0; i < 90; i++) await mutate(`tick ${i}`), await run(950);
    expect(sent).toEqual([]);
    const at = Date.now();
    decision = { replay: true, rule_id: 'r_err' };
    handle!.go();
    await run(100);
    expect(states.at(-1)).toBe('recording');
    expect(sent[0].q).toMatchObject({ q: '0', fs: '1', r: 'r_err' });
    // The ring holds the previous checkout: the replay starts at least 60 s before the trigger.
    expect(at - Number(sent[0].q.ft)).toBeGreaterThanOrEqual(60_000);
    expect(at - Number(sent[0].q.ft)).toBeLessThanOrEqual(122_000);
  });

  it('pauses while hidden, sending what it holds, and resumes with a snapshot', async () => {
    start();
    await mutate('one');
    visibility('hidden');
    await run(100);
    expect(states.at(-1)).toBe('hidden');
    const tags = sent.flatMap((s) => s.events).map((e) => e.data?.tag).filter(Boolean);
    expect(tags).toEqual(['sq-pause']);
    const before = sent.length;
    await run(60_000);
    expect(sent.length).toBe(before);
    visibility('visible');
    await run(100);
    expect(sent.at(-1)!.q.fs).toBe('1');
  });

  it('pauses after the idle time without input, and wakes on input', async () => {
    start({ cfg: normalizeConfig({ v: 2, limits: { idle_pause_ms: 60_000 } }, 'a') });
    await run(80_000);
    expect(states.at(-1)).toBe('idle');
    window.dispatchEvent(new Event('pointerdown'));
    await run(100);
    expect(states.at(-1)).toBe('recording');
  });

  it('asks the core every 15 s whether the session is still live', async () => {
    const check = vi.fn();
    start({ check });
    await run(46_000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('on pagehide sends the open segment as a final keepalive tail', async () => {
    start();
    await run(100);
    await mutate('last words');
    pagehide();
    await run(100);
    const tail = sent.at(-1)!;
    expect(tail.q).toMatchObject({ fin: '1', q: '1' });
    expect(tail.keepalive).toBe(true);
    expect(tail.type).toBe('application/json');
    expect(JSON.stringify(tail.events)).toContain('last words');
  });

  it('a buffering page that never matched sends nothing on pagehide', async () => {
    decision = { replay: false };
    start({ live: false });
    await mutate('unsent');
    pagehide();
    await run(100);
    expect(sent).toEqual([]);
  });

  it('back from the back-forward cache it records a new page load from 0', async () => {
    start();
    await run(100);
    pagehide(true);
    pageLoad = 'pl-restored';
    pageshow();
    await run(100);
    const restored = sent.filter((s) => s.q.p === 'pl-restored');
    expect(restored[0].q).toMatchObject({ q: '0', fs: '1' });
  });

  it('a restarted recorder continues its page load\'s numbering', async () => {
    start();
    await run(100);
    handle!.stop();
    await run(100);
    start();
    await run(100);
    const qs = sent.map((s) => Number(s.q.q));
    expect(new Set(qs).size).toBe(qs.length);
    expect(qs).toEqual([...qs].sort((a, b) => a - b));
  });

  it('stop() delivers the open segment; stop(true) drops it', async () => {
    start();
    await run(100);
    await mutate('kept');
    handle!.stop();
    await run(100);
    expect(JSON.stringify(sent.at(-1)!.events)).toContain('kept');
    start();
    await run(100);
    await mutate('dropped');
    handle!.stop(true);
    await run(100);
    expect(JSON.stringify(sent.flatMap((s) => s.events))).not.toContain('dropped');
  });

  it('past its own request budget replay stops, drops what it holds, warns once and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('_sq_bgr', `${SID}|${REPLAY_LIMITS[2]}|0`);
    start();
    await run(200);
    expect(sent).toEqual([]);
    expect(states.at(-1)).toBe('replay_budget');
    expect(counts).toContain('replay_budget');
    expect(warn).toHaveBeenCalledTimes(1);
    await mutate('after');
    await run(60_000);
    expect(fetches).toBe(0);
  });

  it('forgets the 2.0.0 lease and shared counter', () => {
    localStorage.setItem('_sq_rl', `${SID}|w|1`);
    localStorage.setItem('_sq_rseq', `${SID}:4`);
    start();
    expect(localStorage.getItem('_sq_rl')).toBeNull();
    expect(localStorage.getItem('_sq_rseq')).toBeNull();
  });

  it('removes every listener and timer when stopped', async () => {
    const check = vi.fn();
    start({ check });
    handle!.stop();
    handle = null;
    await run(31_000);
    expect(check).not.toHaveBeenCalled();
  });
});
