import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBudget, PAGE_MAX_REQUESTS, SESSION_MAX_REQUESTS, PAGE_MAX_BYTES } from '../src/core/budget';
import { SiteQwalityRUM } from '../src/sdk';
import { boot, clearStorage, settle, setVisibility, stubNetwork } from './helpers/sdk';

beforeEach(() => clearStorage());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createBudget', () => {
  it('caps requests and bytes per page load', () => {
    const b = createBudget(() => undefined);
    for (let i = 0; i < PAGE_MAX_REQUESTS; i++) expect(b.take('s1', 10)).toBe(true);
    expect(b.take('s1', 10)).toBe(false);
    const c = createBudget(() => undefined);
    expect(c.take('s1', PAGE_MAX_BYTES + 1)).toBe(false);
    expect(c.take('s1', 100)).toBe(true);
  });

  it('caps a session across page loads through storage, and starts over for a new session', () => {
    localStorage.setItem('_sq_bgt', `s1|${SESSION_MAX_REQUESTS - 1}|0`);
    const b = createBudget(() => 'localStorage');
    expect(b.take('s1', 0)).toBe(true);
    expect(b.take('s1', 0)).toBe(false);
    expect(b.take('s2', 0)).toBe(true);
    expect(localStorage.getItem('_sq_bgt')).toBe('s2|1|0');
  });
});

describe('the SDK under a runaway loop', () => {
  it('a hidden-tab loop is capped at the page budget, stops once, and resumes on a new session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const net = await boot();
    const sent = () => net.fetch.mock.calls.length;
    const before = sent();
    // A bug flushing on every tick, the 2026-10-03 shape: one event, one hide, one request.
    for (let i = 0; i < PAGE_MAX_REQUESTS + 500; i++) {
      SiteQwalityRUM.addAction(`loop ${i}`);
      setVisibility('hidden');
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      if (i % 200 === 0) await settle(1);
    }
    await settle(5);
    expect(sent() - before).toBeLessThanOrEqual(PAGE_MAX_REQUESTS);
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

describe('replay requests share the budget', () => {
  it('the replay chunk is handed the budgeted fetch', async () => {
    vi.resetModules();
    const captured: { fetch?: typeof fetch } = {};
    vi.doMock('../src/replay/load-record', () => ({
      loadReplay: async () => (o: { fetch: typeof fetch }) => {
        captured.fetch = o.fetch;
        return { stop() {}, pause() {}, resume() {} };
      },
    }));
    const { SiteQwalityRUM: Fresh } = await import('../src/sdk');
    stubNetwork();
    Fresh._reset();
    await Fresh.init({ applicationId: 'app-1', clientToken: 't', ingestBase: 'https://in.test', configBase: 'https://cdn.test' });
    Fresh.startReplay({ force: true });
    await settle(5);
    expect(captured.fetch).toBeDefined();
    let refused = 0;
    for (let i = 0; i < PAGE_MAX_REQUESTS + 10; i++) await captured.fetch!('https://rp.test/v1/segments', { method: 'POST', body: '[]' }).catch(() => refused++);
    expect(refused).toBeGreaterThanOrEqual(10);
    expect(Fresh.getStatus()!.reason).toBe('request_budget');
    vi.doUnmock('../src/replay/load-record');
  }, 60_000);
});
