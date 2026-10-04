import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeConfig, fetchConfig, loadCachedConfig, saveCachedConfig, clearCachedConfig } from '../src/core/config';

const APP = 'app-1';

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('normalizeConfig', () => {
  it('has safe defaults: no rules, inputs masked, Balanced patterns, GPC honoured', () => {
    const c = normalizeConfig(null, APP);
    expect(c.rules).toEqual([]);
    expect(c.status).toBe('active');
    expect(c.privacy).toMatchObject({ level: 'balanced', mask_inputs: true, mask_text: false, pii_patterns: ['email', 'card', 'digits9'], honor_gpc: true, require_consent: false });
    expect(c.capture.console).toEqual(['error', 'warn']);
    expect(c.capture.network.header_allowlist).toEqual(['content-type', 'x-request-id']);
    expect(c.capture.network.max_body_bytes).toBe(10240);
  });

  it('reads the 6.2 example', () => {
    const c = normalizeConfig(
      {
        v: 2,
        application_id: APP,
        revision: 42,
        status: 'active',
        observe: { sample_rate: 1.0 },
        rules: [
          { id: 'r_1f2e', capture: 'replay', sample_rate: 1.0, conditions: [{ kind: 'error' }], min_duration_ms: 0, require_interaction: false },
          { id: 'r_8a0c', capture: 'replay', sample_rate: 0.083, auto: true, conditions: [], min_duration_ms: 3000, require_interaction: true },
          { id: 'bad', capture: 'nope', sample_rate: 1 },
        ],
        privacy: { level: 'balanced', never_record_urls: ['/checkout/payment'], honor_gpc: true },
        capture: { resource_exclusions: ['/b'], errors: { suppressed_keys: [3141592653, 'x'] }, frustration_ignore_selectors: ['.carousel-next'] },
        limits: { dnr: true },
      },
      APP,
    );
    expect(c.revision).toBe(42);
    expect(c.rules.map((r) => r.id)).toEqual(['r_1f2e', 'r_8a0c']);
    expect(c.rules[1]).toMatchObject({ auto: true, min_duration_ms: 3000, require_interaction: true, sample_rate: 0.083 });
    expect(c.privacy.never_record_urls).toEqual(['/checkout/payment']);
    expect(c.capture.errors.suppressed_keys).toEqual([3141592653]);
    expect(c.capture.resource_exclusions).toEqual(['/b']);
    expect(c.limits.dnr).toBe(true);
  });

  it('derives level defaults: Strict masks text and click names, Relaxed scrubs nothing, null is legacy', () => {
    expect(normalizeConfig({ privacy: { level: 'strict' } }, APP).privacy).toMatchObject({ mask_text: true, hide_action_text: true });
    expect(normalizeConfig({ privacy: { level: 'relaxed' } }, APP).privacy.pii_patterns).toEqual([]);
    const legacy = normalizeConfig({ privacy: { level: null, mask_text: true, pii_patterns: [] } }, APP).privacy;
    expect(legacy).toMatchObject({ level: null, mask_text: true, pii_patterns: [] });
  });

  it('ignores mistyped values and clamps rates and sizes', () => {
    const c = normalizeConfig({ observe: { sample_rate: 7 }, privacy: { mask_inputs: 'no', block_selectors: ['a', 3] }, capture: { network: { max_body_bytes: 1e9 } } }, APP);
    expect(c.observe.sample_rate).toBe(1);
    expect(c.privacy.mask_inputs).toBe(true);
    expect(c.privacy.block_selectors).toEqual(['a']);
    expect(c.capture.network.max_body_bytes).toBe(65536);
  });

  it('a paused app', () => {
    expect(normalizeConfig({ v: 2, status: 'paused' }, APP).status).toBe('paused');
  });
});

describe('fetchConfig', () => {
  it('is a simple CORS GET: no credentials, no custom headers', async () => {
    const f = vi.fn(async () => new Response('{"v":2}'));
    await expect(fetchConfig('https://cdn.example/', APP, f)).resolves.toEqual({ v: 2 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cdn.example/rum/config/v2/app-1.json');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toBeUndefined();
    expect(init.method).toBeUndefined();
  });

  it('rejects other shapes, errors, and after 3 s', async () => {
    await expect(fetchConfig('https://c', APP, async () => new Response('{"v":1}'))).rejects.toThrow();
    await expect(fetchConfig('https://c', APP, async () => new Response('', { status: 404 }))).rejects.toThrow();
    vi.useFakeTimers();
    const p = fetchConfig('https://c', APP, () => new Promise(() => {}));
    vi.advanceTimersByTime(3001);
    await expect(p).rejects.toThrow('timeout');
  });
});

describe('the config cache', () => {
  it('stores the raw config with its time under _sq_cfg_<app>', () => {
    saveCachedConfig(APP, { v: 2, revision: 3 });
    const c = loadCachedConfig(APP)!;
    expect(c.config.revision).toBe(3);
    expect(c.raw).toEqual({ v: 2, revision: 3 });
    expect(Date.now() - c.at).toBeLessThan(1000);
    clearCachedConfig(APP);
    expect(loadCachedConfig(APP)).toBeNull();
  });

  it('ignores a corrupt entry', () => {
    localStorage.setItem(`_sq_cfg_${APP}`, '{nope');
    expect(loadCachedConfig(APP)).toBeNull();
  });
});
