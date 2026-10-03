import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import { startResourceCollector } from '../src/collectors/resources';

/**
 * init must hand the resource collector the bases it actually sends to, custom
 * or default, or the SDK records (and on a hidden page re-sends) its own
 * requests. Every other collector is stubbed: they need browser APIs jsdom
 * does not provide, and only the wiring is under test here.
 */
vi.mock('../src/collectors/resources', () => ({
  startResourceCollector: vi.fn(),
}));
vi.mock('../src/collectors/views', () => ({ startViewCollector: vi.fn() }));
vi.mock('../src/collectors/vitals', () => ({ startVitalsCollector: vi.fn() }));
vi.mock('../src/collectors/errors', () => ({ startErrorCollector: vi.fn() }));
vi.mock('../src/collectors/actions', () => ({ startActionCollector: vi.fn() }));
vi.mock('../src/collectors/long-tasks', () => ({ startLongTaskCollector: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  // Remote config unavailable: init falls back to defaults and carries on.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  vi.mocked(startResourceCollector).mockClear();
});

afterEach(() => {
  (SiteQwalityRUM as unknown as { instance: unknown }).instance = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function ownBases(): readonly string[] {
  expect(startResourceCollector).toHaveBeenCalledTimes(1);
  return vi.mocked(startResourceCollector).mock.calls[0][2];
}

describe('init', () => {
  it('passes the default ingest and replay bases to the resource collector', async () => {
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    expect(ownBases()).toEqual([
      'https://rum.siteqwality.com',
      'https://replay.siteqwality.com',
    ]);
  });

  it('passes custom ingest and replay bases to the resource collector', async () => {
    await SiteQwalityRUM.init({
      applicationId: 'app-1',
      clientToken: 'ct_1',
      ingestBase: 'https://telemetry.customer.example/rum',
      replayBase: 'https://telemetry.customer.example/replay',
    });
    expect(ownBases()).toEqual([
      'https://telemetry.customer.example/rum',
      'https://telemetry.customer.example/replay',
    ]);
  });
});
