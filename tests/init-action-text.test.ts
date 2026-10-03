import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import { startActionCollector } from '../src/collectors/actions';

// Only the hide_action_text wiring is under test; the collectors are stubbed.
vi.mock('../src/collectors/resources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/collectors/resources')>()),
  startResourceCollector: vi.fn(),
}));
vi.mock('../src/collectors/views', () => ({ startViewCollector: vi.fn() }));
vi.mock('../src/collectors/vitals', () => ({ startVitalsCollector: vi.fn() }));
vi.mock('../src/collectors/errors', () => ({ startErrorCollector: vi.fn() }));
vi.mock('../src/collectors/actions', () => ({ startActionCollector: vi.fn() }));
vi.mock('../src/collectors/long-tasks', () => ({ startLongTaskCollector: vi.fn() }));

function configResponse(privacy: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      data: {
        application_id: 'app-1',
        filters: [],
        settings: { privacy: { mask_inputs: true, mask_text: false, ...privacy } },
      },
    }),
  } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(startActionCollector).mockClear();
});

afterEach(() => {
  (SiteQwalityRUM as unknown as { instance: unknown }).instance = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function hideGetter(): () => boolean {
  expect(startActionCollector).toHaveBeenCalledTimes(1);
  const getter = vi.mocked(startActionCollector).mock.calls[0][0].hideText;
  expect(getter).toBeTypeOf('function');
  return getter!;
}

describe('init hide_action_text', () => {
  it('follows the remote privacy setting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(configResponse({ hide_action_text: true })),
    );
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    expect(hideGetter()()).toBe(true);
  });

  it('is off when the field is missing or the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    expect(hideGetter()()).toBe(false);
  });

  it('picks up a change from the periodic config refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(configResponse({}))
      .mockResolvedValue(configResponse({ hide_action_text: true }));
    vi.stubGlobal('fetch', fetchMock);

    await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    const hide = hideGetter();
    expect(hide()).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
    expect(hide()).toBe(true);
  });
});
