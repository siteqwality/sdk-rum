// A long-lived tab whose page ticks a clock every second (the thesecretsproject shape): replay
// must pause while hidden or idle, never outlive its session, and send a bounded number of requests.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { SiteQwalityRUM } from '../src/sdk';
import { APP, clearStorage, config, rule, stubNetwork, type Net } from './helpers/sdk';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

let net: Net;
let tick: ReturnType<typeof setInterval>;

// rrweb keeps the Date.now it first imports with, so the fake clock goes in first.
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: Date.now() });
  await import('@rrweb/record');
  await import('../src/replay/chunk');
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function visibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

const requests = () => net.fetch.mock.calls.length;
const segmentCalls = () => net.fetch.mock.calls.filter((c) => String(c[0]).includes('/v1/segments'));
const segmentsAt = (n: number) => net.fetch.mock.calls.slice(0, n).filter((c) => String(c[0]).includes('/v1/segments')).length;
const fullSnapshots = (sid: string) =>
  net.segments.filter((s) => s.body.session_id === sid && s.body.events.some((e) => (e as { type: number }).type === 2)).length;

/** Advances the fake clock a second at a time, so the page's clock ticks as it would. */
async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += SECOND) await vi.advanceTimersByTimeAsync(SECOND);
}

beforeEach(async () => {
  clearStorage();
  document.body.innerHTML = '<main><h1>Dashboard</h1><p id="clock">0</p></main>';
  const clock = document.getElementById('clock')!;
  tick = setInterval(() => (clock.textContent = new Date().toISOString()), SECOND);
  net = stubNetwork(config({ rules: [rule('replay')] }));
  SiteQwalityRUM._reset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  // Memory sessions: earlier tests' instances stay attached and would adopt a shared cookie.
  void SiteQwalityRUM.init({ applicationId: APP, clientToken: 'ct_1', ingestBase: 'https://in.test', replayBase: 'https://rp.test', configBase: 'https://cdn.test', persistence: 'memory' });
  await run(3 * SECOND);
});

afterEach(() => {
  clearInterval(tick);
  SiteQwalityRUM.stopReplay();
  SiteQwalityRUM._reset();
});

describe('a long-lived tab with a 1 s ticking clock', () => {
  it('records while visible and active, with one request per 30 s at most', async () => {
    const sid = SiteQwalityRUM.getStatus()!.session_id;
    expect(SiteQwalityRUM.getStatus()!.recording).toBe('recording');
    expect(fullSnapshots(sid)).toBe(1);
    const from = segmentCalls().length;
    for (let m = 0; m < 4; m++) {
      await run(MINUTE);
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    }
    // 30 s segments plus one 3 min checkout, never a request per tick.
    const sent = segmentCalls().length - from;
    expect(sent).toBeGreaterThanOrEqual(6);
    expect(sent).toBeLessThanOrEqual(11);
  });

  it('hidden for an hour: nothing is sent, and showing it again resumes with a snapshot', async () => {
    const sid = SiteQwalityRUM.getStatus()!.session_id;
    visibility('hidden');
    await run(5 * SECOND);
    expect(SiteQwalityRUM.getStatus()).toMatchObject({ recording: 'paused', reason: 'hidden' });
    const before = requests();
    await run(60 * MINUTE);
    expect(requests() - before).toBe(0);

    // The session ran out while hidden: the tab comes back under a new one, from a snapshot.
    visibility('visible');
    await run(3 * SECOND);
    const now = SiteQwalityRUM.getStatus()!;
    expect(now.session_id).not.toBe(sid);
    expect(now.recording).toBe('recording');
    expect(fullSnapshots(now.session_id)).toBe(1);
  });

  it('visible but idle for an hour: replay pauses after 5 min and stays quiet', async () => {
    const start = requests();
    await run(6 * MINUTE);
    expect(SiteQwalityRUM.getStatus()).toMatchObject({ recording: 'paused', reason: 'idle' });
    const firstSixMinutes = requests() - start;
    expect(firstSixMinutes).toBeLessThanOrEqual(20);
    // Interim view updates every 5 min while the session lives (design 5.6), no replay.
    let before = requests();
    await run(10 * MINUTE);
    expect(requests() - before).toBeLessThanOrEqual(2);
    expect(segmentCalls().length).toBe(segmentsAt(before));
    before = requests();
    await run(44 * MINUTE);
    expect(requests() - before).toBe(0);

    // Input after the session expired starts a new session, recorded from a snapshot.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await run(3 * SECOND);
    const now = SiteQwalityRUM.getStatus()!;
    expect(now.recording).toBe('recording');
    expect(fullSnapshots(now.session_id)).toBe(1);
  });

  it('a never-record page is never snapshotted; recording starts on leaving it', async () => {
    SiteQwalityRUM.stopReplay();
    SiteQwalityRUM._reset();
    history.pushState({}, '', '/secret/page');
    net = stubNetwork(config({ rules: [rule('replay')], privacy: { never_record_urls: ['/secret'] } }));
    void SiteQwalityRUM.init({ applicationId: APP, clientToken: 'ct_1', ingestBase: 'https://in.test', replayBase: 'https://rp.test', configBase: 'https://cdn.test', persistence: 'memory' });
    await run(3 * SECOND);
    expect(SiteQwalityRUM.getStatus()).toMatchObject({ recording: 'paused', reason: 'privacy_url' });
    expect(segmentCalls()).toHaveLength(0);
    history.pushState({}, '', '/public');
    await run(3 * SECOND);
    expect(SiteQwalityRUM.getStatus()!.recording).toBe('recording');
    expect(fullSnapshots(SiteQwalityRUM.getStatus()!.session_id)).toBe(1);
    history.pushState({}, '', '/');
  });

  it('pointer moves keep replay awake, but recording stops when the session expires', async () => {
    const sid = SiteQwalityRUM.getStatus()!.session_id;
    for (let m = 0; m < 20; m++) {
      await run(MINUTE);
      document.body.dispatchEvent(new Event('pointermove', { bubbles: true }));
      if (m === 8) expect(SiteQwalityRUM.getStatus()!.recording).toBe('recording');
    }
    // 15 min without input ended the session; pointer moves alone never start a new one.
    expect(SiteQwalityRUM.getStatus()!.recording).toBe('off');
    expect(new Set(net.segments.map((s) => s.body.session_id))).toEqual(new Set([sid]));
    const before = requests();
    await run(30 * MINUTE);
    expect(requests() - before).toBe(0);
  });
});
