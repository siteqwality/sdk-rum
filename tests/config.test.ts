import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigManager, defaultSdkConfig } from '../src/config';
import type { SdkConfig } from '../src/types';

const APP_ID = 'a1b2c3d4-0000-0000-0000-000000000000';
const INGEST_BASE = 'https://rum.example.com';

const remoteConfig: SdkConfig = {
  application_id: APP_ID,
  filters: [{ filter_type: 'error', conditions: {}, capture_replay: true }],
  settings: { privacy: { mask_inputs: false, mask_text: true } },
};

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ConfigManager', () => {
  it('returns the remote config when the fetch succeeds', async () => {
    const fetchMock = vi.fn(async () => okResponse({ data: remoteConfig }));
    vi.stubGlobal('fetch', fetchMock);

    const mgr = new ConfigManager();
    const cfg = await mgr.init(APP_ID, 'token-1', INGEST_BASE);
    mgr.destroy();

    expect(cfg).toEqual(remoteConfig);
    expect(mgr.getConfig()).toEqual(remoteConfig);
    expect(fetchMock).toHaveBeenCalledWith(
      `${INGEST_BASE}/v1/config`,
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-1' },
      }),
    );
  });

  it('falls back to defaults when the fetch rejects (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const mgr = new ConfigManager();
    const cfg = await mgr.init(APP_ID, 'token-1', INGEST_BASE);
    mgr.destroy();

    expect(cfg).toEqual(defaultSdkConfig(APP_ID));
    expect(cfg.filters).toEqual([]);
    expect(cfg.settings.privacy.mask_inputs).toBe(true);
  });

  it('falls back to defaults on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 }) as Response),
    );

    const mgr = new ConfigManager();
    const cfg = await mgr.init(APP_ID, 'bad-token', INGEST_BASE);
    mgr.destroy();

    expect(cfg).toEqual(defaultSdkConfig(APP_ID));
  });

  it('falls back to defaults when the response shape is unexpected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ nope: true })),
    );

    const mgr = new ConfigManager();
    const cfg = await mgr.init(APP_ID, 'token-1', INGEST_BASE);
    mgr.destroy();

    expect(cfg).toEqual(defaultSdkConfig(APP_ID));
  });

  it('falls back to defaults when the fetch times out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );

    const mgr = new ConfigManager();
    const initPromise = mgr.init(APP_ID, 'token-1', INGEST_BASE);
    await vi.advanceTimersByTimeAsync(6_000);
    const cfg = await initPromise;
    mgr.destroy();

    expect(cfg).toEqual(defaultSdkConfig(APP_ID));
  });

  it('keeps the last known config when a periodic refresh fails', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ data: remoteConfig }))
      .mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const mgr = new ConfigManager();
    await mgr.init(APP_ID, 'token-1', INGEST_BASE);
    expect(mgr.getConfig()).toEqual(remoteConfig);

    // Advance past the 5-minute refresh; the failing refresh must not
    // clobber the config.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(mgr.getConfig()).toEqual(remoteConfig);
    mgr.destroy();
  });
});
