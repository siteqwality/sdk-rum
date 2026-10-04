import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBudget, CORE_LIMITS, REPLAY_LIMITS, budgetError } from '../src/core/budget';
import { SiteQwalityRUM } from '../src/sdk';
import { boot, clearStorage, config, rule, settle, setVisibility, stubNetwork, throwInPage } from './helpers/sdk';

const [PAGE_REQ, PAGE_BYTES, SESS_REQ, SESS_BYTES] = CORE_LIMITS;
const [, , REPLAY_SESS_REQ] = REPLAY_LIMITS;
const unit = (kind: () => 'localStorage' | undefined = () => undefined) => createBudget(kind, '_sq_bgt', CORE_LIMITS);

beforeEach(() => clearStorage());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createBudget', () => {
  it('caps requests and bytes per session', () => {
    const b = unit();
    for (let i = 0; i < SESS_REQ; i++) expect(b.take('s1', 10)).toBe(true);
    expect(b.take('s1', 10)).toBe(false);
    const c = unit();
    expect(c.take('s1', SESS_BYTES + 1)).toBe(false);
    expect(c.take('s1', 100)).toBe(true);
  });

  it('holds the page ceiling across the sessions of one document', () => {
    const b = unit();
    let taken = 0;
    for (let s = 0; s < 5; s++) for (let i = 0; i < SESS_REQ; i++) taken += b.take(`s${s}`, 0) ? 1 : 0;
    expect(taken).toBe(PAGE_REQ);
    expect(b.pageOpen()).toBe(false);
    expect(unit().take('s9', PAGE_BYTES + 1)).toBe(false);
  });

  it('caps a session across page loads through storage, and starts over for a new session', () => {
    localStorage.setItem('_sq_bgt', `s1|${SESS_REQ - 1}|0`);
    const b = unit(() => 'localStorage');
    expect(b.take('s1', 0)).toBe(true);
    expect(b.take('s1', 0)).toBe(false);
    expect(b.take('s2', 0)).toBe(true);
    expect(localStorage.getItem('_sq_bgt')).toBe('s2|1|0');
  });

  it('tabs sharing a session add to one count', () => {
    const a = unit(() => 'localStorage');
    const b = unit(() => 'localStorage');
    for (let i = 0; i < SESS_REQ / 2; i++) {
      expect(a.take('s1', 1)).toBe(true);
      expect(b.take('s1', 1)).toBe(true);
    }
    expect(a.take('s1', 1)).toBe(false);
    expect(b.take('s1', 1)).toBe(false);
  });

  it('keeps counting when storage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const b = unit(() => 'localStorage');
    for (let i = 0; i < SESS_REQ; i++) b.take('s1', 0);
    expect(b.take('s1', 0)).toBe(false);
  });
});

describe('the SDK under a runaway loop', () => {
  it('a hidden-tab loop is capped at the session budget, stops once, and resumes on a new session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const net = await boot();
    const sent = () => net.fetch.mock.calls.length;
    const before = sent();
    // A bug flushing on every tick, the 2026-10-03 shape: one event, one hide, one request.
    for (let i = 0; i < SESS_REQ + 500; i++) {
      SiteQwalityRUM.addAction(`loop ${i}`);
      setVisibility('hidden');
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      if (i % 200 === 0) await settle(1);
    }
    await settle(5);
    expect(sent() - before).toBeLessThanOrEqual(SESS_REQ);
    expect(sent() - before).toBeGreaterThan(SESS_REQ - 100);
    const capped = sent();
    for (let i = 0; i < 50; i++) {
      SiteQwalityRUM.addAction(`after ${i}`);
      setVisibility('hidden');
    }
    await settle(5);
    expect(sent()).toBe(capped);
    const status = SiteQwalityRUM.getStatus()!;
    expect(status).toMatchObject({ recording: 'stopped', reason: 'request_budget' });
    expect(status.dropped.request_budget).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('request budget'))).toHaveLength(1);

    // A new session gets a fresh budget.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60_000 });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    SiteQwalityRUM.addAction('new session');
    setVisibility('hidden');
    vi.useRealTimers();
    await settle(10);
    expect(sent()).toBeGreaterThan(capped);
    expect(SiteQwalityRUM.getStatus()!.reason).not.toBe('request_budget');
  }, 60_000);

  it('normal traffic never comes near the budget', async () => {
    const net = await boot();
    for (let i = 0; i < 200; i++) SiteQwalityRUM.addAction(`a${i}`);
    setVisibility('hidden');
    await settle(10);
    expect(SiteQwalityRUM.getStatus()!.dropped.request_budget).toBeUndefined();
    expect(net.events('custom')).toHaveLength(200);
  });
});

describe('the replay budget', () => {
  type Opts = { fetch: typeof fetch; send: unknown; store: unknown; windowId: string; onStatus: (s: string, why?: string) => void };
  async function bootWithReplay(stopsAtOnce = false) {
    vi.resetModules();
    const captured: { o?: Opts; stops: Array<boolean | undefined>; starts: number } = { stops: [], starts: 0 };
    vi.doMock('../src/replay/load-record', () => ({
      loadReplay: async () => (o: Opts) => {
        captured.o = o;
        captured.starts++;
        if (stopsAtOnce) o.onStatus('stopped', 'too_large');
        return { stop: (d?: boolean) => captured.stops.push(d), pause() {}, resume() {} };
      },
    }));
    const { SiteQwalityRUM: Fresh } = await import('../src/sdk');
    const net = stubNetwork(config({ rules: [rule('replay')] }));
    Fresh._reset();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await Fresh.init({ applicationId: 'app-1', clientToken: 't', ingestBase: 'https://in.test', replayBase: 'https://rp.test', configBase: 'https://cdn.test' });
    await settle(5);
    return { Fresh, net, captured };
  }
  afterEach(() => vi.doUnmock('../src/replay/load-record'));

  it('hands the chunk the core send and the session store', async () => {
    const { captured } = await bootWithReplay();
    expect(captured.o).toBeDefined();
    expect(typeof captured.o!.send).toBe('function');
    expect(captured.o!.store).toBe('localStorage');
    expect(captured.o!.windowId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a replay cap stops only replay, for the session: errors and views still go', async () => {
    const { Fresh, net, captured } = await bootWithReplay();
    // The chunk counts and reports its budget spent (its own warning is tested with the chunk).
    captured.o!.count('replay_budget');
    captured.o!.onStatus('stopped', 'replay_budget');
    expect(Fresh.getStatus()).toMatchObject({ recording: 'stopped', reason: 'replay_budget' });
    expect(Fresh.getStatus()!.dropped.replay_budget).toBe(1);
    setVisibility('hidden');
    setVisibility('visible');
    await settle(5);
    expect(captured.starts).toBe(1);

    throwInPage(new Error('still reported'));
    setVisibility('hidden');
    await settle(10);
    expect(net.events('error').map((e) => e.message)).toContain('still reported');
  }, 60_000);

  it('the core budget stops replay too, dropping what it holds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { Fresh, captured } = await bootWithReplay();
    expect(await captured.o!.fetch('https://rp.test/v2/segments', { method: 'POST', body: '{"events":[]}' }).then(() => true)).toBe(true);
    // Spend the core budget through the batch path.
    for (let i = 0; i < SESS_REQ + 5; i++) {
      Fresh.addAction(`loop ${i}`);
      setVisibility('hidden');
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      if (i % 200 === 0) await settle(1);
    }
    await settle(5);
    expect(Fresh.getStatus()!.reason).toBe('request_budget');
    expect(captured.stops).toContain(true);
    await expect(captured.o!.fetch('https://rp.test/v2/segments', { method: 'POST', body: '[]' })).rejects.toMatchObject({ name: budgetError().name });
  }, 60_000);

  it('a page too large to record stays off for the page load, whatever the tab does', async () => {
    const { Fresh, captured } = await bootWithReplay();
    expect(captured.starts).toBe(1);
    captured.o!.onStatus('stopped', 'too_large');
    for (let i = 0; i < 3; i++) {
      setVisibility('hidden');
      setVisibility('visible');
      await settle(3);
    }
    expect(captured.starts).toBe(1);
    expect(Fresh.getStatus()).toMatchObject({ recording: 'stopped', reason: 'too_large' });
  });

  it('never keeps a handle whose recording stopped inside start', async () => {
    const { Fresh, captured } = await bootWithReplay(true);
    expect(Fresh.getStatus()).toMatchObject({ recording: 'stopped', reason: 'too_large' });
    Fresh.setTrackingConsent('pending');
    expect(captured.stops).toEqual([]);
  });
});
