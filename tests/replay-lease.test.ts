// One tab records a shared session at a time (2.0.0, until per-window segments in 2.1): the
// lease in localStorage, takeovers that start with a full snapshot, and releases.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { ReplayHandle, ReplayStartOptions } from '../src/replay/chunk';
import { createUrlSanitizer, createTextUrlSanitizer } from '../src/core/url';
import { normalizeConfig } from '../src/core/config';
import { REPLAY_LIMITS } from '../src/core/budget';
import { send } from '../src/core/send';

const SID = '01a10521-0000-7000-8000-000000000001';
const ME = 'w-me';
let startReplay: (o: ReplayStartOptions) => ReplayHandle;
let LEASE_KEY: string;
let TAKEOVER_MS: number;
let handle: ReplayHandle | null;
let sent: Array<{ index: number; types: number[] }>;
let states: string[];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: Date.now() });
  await import('@rrweb/record');
  ({ startReplay } = await import('../src/replay/chunk'));
  ({ LEASE_KEY, TAKEOVER_MS } = await import('../src/replay/lease'));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<p id="p">hello</p>';
  sent = [];
  states = [];
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
});
afterEach(() => {
  handle?.stop();
  handle = null;
  vi.restoreAllMocks();
});

const url = createUrlSanitizer();
function start(): ReplayHandle {
  handle = startReplay({
    mode: 'stream',
    sessionId: SID,
    windowId: ME,
    store: 'localStorage',
    replayBase: 'https://rp.test',
    token: 't',
    fetch: (async (u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      sent.push({ index: Number(new URL(u).searchParams.get('segment_index')), types: b.events.map((e: { type: number }) => e.type) });
      return new Response('', { status: 202 });
    }) as unknown as typeof fetch,
    send,
    url,
    text: createTextUrlSanitizer(url),
    privacy: normalizeConfig(null, 'a').privacy,
    mask: (s) => s,
    onStatus: (state, why) => states.push(why ?? state),
    now: () => Date.now(),
  });
  return handle;
}

const lease = (w: string, at = Date.now()) => localStorage.setItem(LEASE_KEY, `${SID}|${w}|${at}`);
const announce = () => window.dispatchEvent(new StorageEvent('storage', { key: LEASE_KEY }));
async function mutate(text: string) {
  document.getElementById('p')!.textContent = text;
  await vi.advanceTimersByTimeAsync(50);
}

describe('the replay lease', () => {
  it('a lone tab takes the lease and records once the takeover delay has passed', async () => {
    start();
    expect(states).toEqual([]);
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    expect(states).toEqual(['recording']);
    expect(localStorage.getItem(LEASE_KEY)).toContain(`|${ME}|`);
    expect(sent[0].types).toEqual([4, 2]);
  });

  it('while another tab holds a live lease, this one waits paused and snapshots nothing', async () => {
    lease('w-other');
    start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(states).toEqual(['other_tab']);
    expect(sent).toEqual([]);
  });

  it('another tab taking over pauses this one at once; a freed lease brings it back from a snapshot', async () => {
    start();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    await mutate('one');
    lease('w-other');
    announce();
    expect(states.at(-1)).toBe('other_tab');
    // The segment open at the pause goes out; nothing after it does.
    await vi.advanceTimersByTimeAsync(10);
    const before = sent.length;
    await mutate('two');
    // The other tab keeps its lease fresh.
    for (let i = 0; i < 4; i++) {
      lease('w-other');
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(sent.length).toBe(before);
    expect(states.at(-1)).toBe('other_tab');

    localStorage.removeItem(LEASE_KEY);
    announce();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    expect(states.at(-1)).toBe('recording');
    expect(sent.at(-1)!.types.slice(0, 2)).toEqual([4, 2]);
    // One counter for the session: indexes never repeat across the pause.
    expect(new Set(sent.map((s) => s.index)).size).toBe(sent.length);
  });

  it('input in a waiting tab takes over; a stale lease is taken without input', async () => {
    lease('w-other');
    start();
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    expect(states.at(-1)).toBe('recording');

    handle!.stop();
    states = [];
    lease('w-crashed', Date.now() - 60_000);
    start();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    expect(states).toEqual(['recording']);
  });

  it('hiding and stopping release the lease', async () => {
    start();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    expect(localStorage.getItem(LEASE_KEY)).toContain(`|${ME}|`);
    handle!.stop();
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
  });

  it('a tab-only or memory session records at once, with no lease', async () => {
    const h = startReplay({
      mode: 'stream',
      sessionId: SID,
      windowId: ME,
      store: 'sessionStorage',
      replayBase: 'https://rp.test',
      token: 't',
      fetch: (() => Promise.resolve(new Response(''))) as typeof fetch,
      send: async () => ({ kind: 'ok' }),
      url,
      text: createTextUrlSanitizer(url),
      privacy: normalizeConfig(null, 'a').privacy,
      mask: (s) => s,
      onStatus: (state, why) => states.push(why ?? state),
      now: () => Date.now(),
    });
    expect(states).toEqual(['recording']);
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
    h.stop();
  });

  it('past its own request budget replay stops, drops what it holds, and says why', async () => {
    localStorage.setItem('_sq_bgr', `${SID}|${REPLAY_LIMITS[2]}|0`);
    start();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS + 100);
    expect(sent).toEqual([]);
    expect(states.at(-1)).toBe('replay_budget');
    await mutate('after');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
  });

  it('the owner refreshes its lease on input and focus without pausing', async () => {
    start();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    states = [];
    for (const type of ['focus', 'pointerdown', 'keydown']) window.dispatchEvent(new Event(type));
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS * 2);
    expect(states).toEqual([]);
  });

  it('a recording tab taking the lease back waits, paused, before its snapshot', async () => {
    start();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    lease('w-other');
    announce();
    await vi.advanceTimersByTimeAsync(10);
    const before = sent.length;
    window.dispatchEvent(new Event('pointerdown'));
    // The other tab gets the takeover delay to stop before this one snapshots.
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS - 50);
    expect(states.at(-1)).toBe('other_tab');
    expect(sent.length).toBe(before);
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)).toBe('recording');
    expect(sent.at(-1)!.types.slice(0, 2)).toEqual([4, 2]);
  });

  it('each session has its own lease: another session neither blocks this one nor loses its own', async () => {
    const other = `01a10521-0000-7000-8000-00000000beef|w-elsewhere|${Date.now()}`;
    localStorage.setItem(LEASE_KEY, other);
    start();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS);
    expect(states).toEqual(['recording']);
    const value = localStorage.getItem(LEASE_KEY)!;
    expect(value).toContain(`${SID}|${ME}|`);
    expect(value).toContain('w-elsewhere');
    // The other session's heartbeat never makes this tab claim again.
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    announce();
    await vi.advanceTimersByTimeAsync(10);
    expect(writes).not.toHaveBeenCalled();
    handle!.stop();
    expect(localStorage.getItem(LEASE_KEY)).toBe(other);
  });

  it('a page too large to record lets go of everything: lease, timers, listeners', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = `<p id="p">x</p><div>${'x'.repeat(4_100_000)}</div>`;
    start();
    await vi.advanceTimersByTimeAsync(TAKEOVER_MS + 10);
    expect(states.at(-1)).toBe('too_large');
    expect(localStorage.getItem(LEASE_KEY)).toBeNull();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    announce();
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).not.toHaveBeenCalled();
    handle = null;
  });
});
