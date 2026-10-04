import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import { startResourceCollector } from '../src/collectors/resources';

// Only the exclusions wiring is under test; the collectors are stubbed.
vi.mock('../src/collectors/resources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/collectors/resources')>()),
  startResourceCollector: vi.fn(),
}));
vi.mock('../src/collectors/views', () => ({ startViewCollector: vi.fn() }));
vi.mock('../src/collectors/vitals', () => ({ startVitalsCollector: vi.fn() }));
vi.mock('../src/collectors/errors', () => ({ startErrorCollector: vi.fn() }));
vi.mock('../src/collectors/actions', () => ({ startActionCollector: vi.fn() }));
vi.mock('../src/collectors/long-tasks', () => ({ startLongTaskCollector: vi.fn() }));

function configResponse(settings: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      data: {
        application_id: 'app-1',
        filters: [],
        settings: { privacy: { mask_inputs: true, mask_text: false }, ...settings },
      },
    }),
  } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(startResourceCollector).mockClear();
});

afterEach(() => {
  (SiteQwalityRUM as unknown as { instance: unknown }).instance = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function exclusionsGetter(): () => readonly string[] | undefined {
  expect(startResourceCollector).toHaveBeenCalledTimes(1);
  const getter = vi.mocked(startResourceCollector).mock.calls[0][3];
  expect(getter).toBeTypeOf('function');
  return getter!;
}

describe('init resource exclusions', () => {
  it('passes the remote config rules to the resource collector', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(configResponse({ resource_exclusions: ['/b'] })),
    );
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    expect(exclusionsGetter()()).toEqual(['/b']);
  });

  it('has no rules when the field is missing or the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    expect(exclusionsGetter()()).toBeUndefined();
  });

  it('picks up new rules from the periodic config refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(configResponse({}))
      .mockResolvedValue(configResponse({ resource_exclusions: ['/b', '/c'] }));
    vi.stubGlobal('fetch', fetchMock);

    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    const getExclusions = exclusionsGetter();
    expect(getExclusions()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
    expect(getExclusions()).toEqual(['/b', '/c']);
  });
});
