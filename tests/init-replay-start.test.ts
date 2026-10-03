import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';

// Only when replay starts is under test; the collectors and rrweb are stubbed.
vi.mock('../src/collectors/resources', () => ({ startResourceCollector: vi.fn() }));
vi.mock('../src/collectors/views', () => ({ startViewCollector: vi.fn() }));
vi.mock('../src/collectors/vitals', () => ({ startVitalsCollector: vi.fn() }));
vi.mock('../src/collectors/errors', () => ({ startErrorCollector: vi.fn() }));
vi.mock('../src/collectors/actions', () => ({ startActionCollector: vi.fn() }));
vi.mock('../src/collectors/long-tasks', () => ({ startLongTaskCollector: vi.fn() }));

const replayStart = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/replay/recorder', () => ({
  ReplayRecorder: class {
    start = replayStart;
    stop() {}
  },
}));

const SESSION = '11111111-1111-4111-8111-111111111111';

function withFilters(filters: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          application_id: 'app-1',
          filters,
          settings: { privacy: { mask_inputs: true, mask_text: false } },
        },
      }),
    }),
  );
}

const replayOnError = { filter_type: 'error', conditions: {}, capture_replay: true };

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  replayStart.mockClear();
});

afterEach(() => {
  (SiteQwalityRUM as unknown as { instance: unknown }).instance = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function earlierPageRecorded() {
  const now = Date.now();
  sessionStorage.setItem(
    'sq_rum_session',
    JSON.stringify({ id: SESSION, started: now, lastActivity: now }),
  );
  sessionStorage.setItem(`sq_rum_replay_next:${SESSION}`, '3');
}

describe('init replay start', () => {
  it('starts replay as soon as init has the config', async () => {
    withFilters([{ filter_type: 'custom', conditions: {}, capture_replay: true }]);
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    expect(replayStart).toHaveBeenCalledTimes(1);
  });

  it('carries on replay an earlier page of the session recorded', async () => {
    earlierPageRecorded();
    withFilters([replayOnError]);
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    expect(replayStart).toHaveBeenCalledTimes(1);
    expect(replayStart.mock.calls[0][0]).toBe(SESSION);
  });

  it('waits for a filter on a session that has not recorded', async () => {
    withFilters([replayOnError]);
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replayStart).not.toHaveBeenCalled();
  });

  it('does not carry on once the app no longer captures replay', async () => {
    earlierPageRecorded();
    withFilters([{ ...replayOnError, capture_replay: false }]);
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replayStart).not.toHaveBeenCalled();
  });
});
