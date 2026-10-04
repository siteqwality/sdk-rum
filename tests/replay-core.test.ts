// The core's side of replay (design 5.4): when the ring buffers, when it streams, and what the
// chunk is told. The chunk itself is stubbed; replay-chunk.test.ts runs the real one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReplayStartOptions } from '../src/replay/chunk';
import { clearStorage, config, rule, settle, setVisibility, stubNetwork, throwInPage, type Net } from './helpers/sdk';

type Handle = { go: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };

let captured: { o?: ReplayStartOptions; starts: number; handle?: Handle };
// Each boot loads a fresh module; earlier instances stay attached to the window.
let current: { optOut(): void } | null = null;

async function boot(rules: unknown[], init: Record<string, unknown> = {}) {
  vi.resetModules();
  captured = { starts: 0 };
  vi.doMock('../src/replay/load-record', () => ({
    loadReplay: async () => (o: ReplayStartOptions) => {
      captured.o = o;
      captured.starts++;
      captured.handle = { go: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn() };
      o.onStatus(o.live ? 'recording' : 'buffering');
      return captured.handle;
    },
  }));
  const { SiteQwalityRUM: Fresh } = await import('../src/sdk');
  current = Fresh;
  const net: Net = stubNetwork(config({ rules }));
  Fresh._reset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  await Fresh.init({ applicationId: 'app-1', clientToken: 't', ingestBase: 'https://in.test', replayBase: 'https://rp.test', configBase: 'https://cdn.test', ...init });
  await settle(5);
  return { Fresh, net };
}

const errorRule = rule('replay', [{ kind: 'error' }], { id: 'r_err' });

beforeEach(() => clearStorage());
afterEach(() => {
  // An opted-out instance in memory never records again, whatever later tests do.
  current?.optOut();
  current = null;
  vi.doUnmock('../src/replay/load-record');
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the replay ring in the core', () => {
  it('an errored-sessions rule loads the recorder at once, buffering; the error makes it stream', async () => {
    const { Fresh, net } = await boot([errorRule]);
    expect(captured.starts).toBe(1);
    expect(captured.o!.live).toBe(false);
    expect(Fresh.getStatus()).toMatchObject({ recording: 'buffering', sampled: { replay: false } });
    expect(captured.o!.session.decision).toMatchObject({ replay: false });
    throwInPage(new Error('boom'));
    await settle(3);
    expect(captured.handle!.go).toHaveBeenCalledTimes(1);
    expect(captured.o!.session.decision).toEqual({ analyze: true, replay: true, rule_id: 'r_err' });
    setVisibility('hidden');
    await settle(10);
    // The batch says the session is sampled for replay only once it is.
    const ctxs = net.batches.map((b) => b.body.ctx.sampling as { replay: boolean });
    expect(ctxs.at(-1)!.replay).toBe(true);
  });

  it('a match already latched for the session streams from the first event', async () => {
    const { Fresh } = await boot([rule('replay', [], { id: 'r_all' })]);
    expect(captured.o!.live).toBe(true);
    expect(Fresh.getStatus()!.recording).toBe('recording');
  });

  it.each([
    ['a device condition', { kind: 'device', class: 'mobile' }, {}],
    ['a release condition', { kind: 'release', op: 'eq', value: '9.9.9' }, { version: '1.0.0' }],
    ['an env condition', { kind: 'env', value: 'staging' }, { env: 'production' }],
  ])('%s this page cannot meet means no ring and no recorder download', async (_, condition, init) => {
    await boot([rule('replay', [{ kind: 'error' }, condition], { id: 'r_dev' })], init);
    expect(captured.starts).toBe(0);
  });

  it('an Analyze rule alone never loads the recorder', async () => {
    await boot([rule('analyze')]);
    expect(captured.starts).toBe(0);
  });

  it('a sampled rule with minimum duration and interaction buffers, then streams once both hold (J11)', async () => {
    await boot([rule('replay', [], { id: 'r_auto', min_duration_ms: 300, require_interaction: true })]);
    expect(captured.o!.live).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(captured.handle!.go).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    expect(captured.handle!.go).toHaveBeenCalledTimes(1);
  });

  it("learns another tab's decision on the chunk's check and streams the ring", async () => {
    await boot([errorRule]);
    // Another tab of the session matched: its decision is in the shared cookie.
    const cookie = /(?:^|;\s*)_sq_s=([^;]*)/.exec(document.cookie)![1].split('|');
    document.cookie = `_sq_s=${cookie.slice(0, 3).join('|')}|3:r_err;path=/`;
    await new Promise((r) => setTimeout(r, 1_100));
    captured.o!.check();
    expect(captured.handle!.go).toHaveBeenCalledTimes(1);
  });

  it('the check stops replay once the session has ended', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await boot([rule('replay', [], { id: 'r_all' })]);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    captured.o!.check();
    expect(captured.handle!.stop).toHaveBeenCalled();
  });

  it('startReplay({ force }) streams a buffering ring, with no rule to name', async () => {
    const { Fresh } = await boot([errorRule]);
    Fresh.startReplay({ force: true });
    expect(captured.handle!.go).toHaveBeenCalledTimes(1);
    expect(captured.o!.session.decision.replay).toBe(false);
    expect(Fresh.getStatus()!.sampled.replay).toBe(true);
  });

  it('sends to in-replay.siteqwality.com unless replayBase says otherwise', async () => {
    await boot([errorRule], { replayBase: undefined });
    expect(captured.o!.replayBase).toBe('https://in-replay.siteqwality.com');
  });

  it('passes the page load id live, so a back-forward cache restore starts a new stream', async () => {
    await boot([errorRule]);
    const before = captured.o!.session.pageLoadId;
    const e = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(e, 'persisted', { value: true });
    window.dispatchEvent(e);
    expect(captured.o!.session.pageLoadId).not.toBe(before);
  });

  it('starts buffering once consent is granted', async () => {
    const { Fresh } = await boot([errorRule], { trackingConsent: 'pending' });
    expect(captured.starts).toBe(0);
    Fresh.setTrackingConsent('granted');
    await settle(3);
    expect(captured.starts).toBe(1);
    expect(captured.o!.live).toBe(false);
  });

  it('opting out drops the ring; opting back in buffers again', async () => {
    const { Fresh } = await boot([errorRule]);
    Fresh.optOut();
    expect(captured.handle!.stop).toHaveBeenCalledWith(true);
    Fresh.optIn();
    await settle(3);
    expect(captured.starts).toBe(2);
    expect(Fresh.getStatus()!.recording).toBe('buffering');
  });

  it('a new session after inactivity buffers too', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    // A memory session: earlier tests' instances share the cookie in this one document.
    const { Fresh } = await boot([errorRule], { persistence: 'memory' });
    const first = Fresh.getStatus()!.session_id;
    vi.setSystemTime(Date.now() + 16 * 60_000);
    window.dispatchEvent(new Event('pointerdown'));
    await settle(3);
    expect(Fresh.getStatus()!.session_id).not.toBe(first);
    expect(captured.starts).toBe(2);
    expect(captured.o!.session.id).toBe(Fresh.getStatus()!.session_id);
    expect(captured.o!.live).toBe(false);
  });

  it('a config that no longer arms any Replay rule drops the ring', async () => {
    const { Fresh, net } = await boot([errorRule]);
    net.config = config({ rules: [], revision: 8 });
    // A visible tab with a cached config older than 5 min refreshes it.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6 * 60_000 });
    setVisibility('visible');
    await settle(5);
    expect(captured.handle!.stop).toHaveBeenCalledWith(true);
    expect(Fresh.getStatus()!.recording).toBe('off');
  });

  it("the check stops a recorder that belongs to another session than the page's", async () => {
    await boot([errorRule]);
    const cookie = /(?:^|;\s*)_sq_s=([^;]*)/.exec(document.cookie)![1].split('|');
    // An older live session in another tab: this page adopts it.
    const older = `0199a6b2-7c3e-7f00-8a1b-1c2d3e4f5a6b|${Number(cookie[1]) - 1000}|${Date.now()}|0`;
    document.cookie = `_sq_s=${older};path=/`;
    await new Promise((r) => setTimeout(r, 1_100));
    captured.o!.check();
    expect(captured.handle!.stop).toHaveBeenCalled();
  });

  it('a session adopted while the recorder loads gets the recorder instead', async () => {
    vi.resetModules();
    captured = { starts: 0 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.doMock('../src/replay/load-record', () => ({
      loadReplay: async () => {
        await gate;
        return (o: ReplayStartOptions) => {
          captured.o = o;
          captured.starts++;
          captured.handle = { go: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn() };
          return captured.handle;
        };
      },
    }));
    const { SiteQwalityRUM: Fresh } = await import('../src/sdk');
    current = Fresh;
    stubNetwork(config({ rules: [errorRule] }));
    Fresh._reset();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await Fresh.init({ applicationId: 'app-1', clientToken: 't', ingestBase: 'https://in.test', replayBase: 'https://rp.test', configBase: 'https://cdn.test' });
    await settle(3);
    const cookie = /(?:^|;\s*)_sq_s=([^;]*)/.exec(document.cookie)![1].split('|');
    const older = `0199a6b2-7c3e-7f00-8a1b-00000000a0a0|${Number(cookie[1]) - 1000}|${Date.now()}|0`;
    document.cookie = `_sq_s=${older};path=/`;
    await new Promise((r) => setTimeout(r, 1_100));
    Fresh.addAction('adopt');
    expect(Fresh.getStatus()!.session_id).toBe('0199a6b2-7c3e-7f00-8a1b-00000000a0a0');
    release();
    await settle(5);
    expect(captured.starts).toBe(1);
    expect(captured.o!.session.id).toBe('0199a6b2-7c3e-7f00-8a1b-00000000a0a0');
  });

  it('rechecks the shared session immediately before sending replay', async () => {
    const { Fresh, net } = await boot([errorRule]);
    const old = captured.o!;
    const cookie = /(?:^|;\s*)_sq_s=([^;]*)/.exec(document.cookie)![1].split('|');
    // Force an earlier cached read, then replace the cookie within the one-second read cache.
    old.check();
    document.cookie = `_sq_s=0199a6b2-7c3e-7f00-8a1b-00000000b0b0|${Number(cookie[1]) - 1000}|${Date.now()}|0;path=/`;
    await expect(old.fetch('https://rp.test/v2/segments', { body: '[]' })).rejects.toMatchObject({ name: 'SqBudget' });
    await settle(5);
    expect(net.segments).toHaveLength(0);
    expect(Fresh.getStatus().session_id).toBe('0199a6b2-7c3e-7f00-8a1b-00000000b0b0');
    expect(captured.starts).toBe(2);
    expect(Fresh.getStatus().recording).toBe('buffering');
  });

  it('never lets a retired recorder retry old data after consent is withdrawn and granted again', async () => {
    const { Fresh, net } = await boot([errorRule]);
    const old = captured.o!;
    Fresh.stopReplay(); // May leave an authorized final segment backing off.
    Fresh.setTrackingConsent('not-granted');
    Fresh.setTrackingConsent('granted');
    await expect(old.fetch('https://rp.test/v2/segments', { body: '[]' })).rejects.toMatchObject({ name: 'SqBudget' });
    expect(net.segments).toHaveLength(0);
  });

  it('a check that adopts another session does not stop its replacement recorder', async () => {
    const { Fresh } = await boot([errorRule]);
    const old = captured.o!;
    const cookie = /(?:^|;\s*)_sq_s=([^;]*)/.exec(document.cookie)![1].split('|');
    document.cookie = `_sq_s=0199a6b2-7c3e-7f00-8a1b-00000000c0c0|${Number(cookie[1]) - 1000}|${Date.now()}|0;path=/`;
    await new Promise((r) => setTimeout(r, 1_100));
    old.check();
    await settle(5);
    expect(captured.starts).toBe(2);
    old.check();
    expect(captured.handle!.stop).not.toHaveBeenCalled();
    expect(Fresh.getStatus().recording).toBe('buffering');
  });

  it('a recorder that failed for the page stays off for the page load', async () => {
    const { Fresh } = await boot([errorRule]);
    captured.o!.onStatus('stopped', 'record_failed');
    throwInPage(new Error('after'));
    await settle(3);
    expect(captured.starts).toBe(1);
    expect(Fresh.getStatus()).toMatchObject({ recording: 'stopped', reason: 'record_failed' });
  });

  it('a session-cap stop blocks forced restarts but a different session may replay', async () => {
    const { Fresh } = await boot([rule('replay')]);
    captured.o!.onStatus('stopped', 'session_cap');
    Fresh.startReplay({ force: true });
    await settle(3);
    expect(captured.starts).toBe(1);
    expect(Fresh.getStatus()).toMatchObject({ recording: 'stopped', reason: 'session_cap' });
    const cookie = /(?:^|;\s*)_sq_s=([^;]*)/.exec(document.cookie)![1].split('|');
    document.cookie = `_sq_s=0199a6b2-7c3e-7f00-8a1b-00000000d0d0|${Number(cookie[1]) - 1000}|${Date.now()}|0;path=/`;
    await new Promise((r) => setTimeout(r, 1_100));
    Fresh.addAction('new session');
    await settle(5);
    expect(captured.starts).toBe(2);
    expect(Fresh.getStatus().recording).toBe('recording');
  });
});
