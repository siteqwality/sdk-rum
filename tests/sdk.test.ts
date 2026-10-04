import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SiteQwalityRUM } from '../src/sdk';
import { VERSION } from '../src/version';
import { APP, boot, clearStorage, config, flush, pagehide, rule, settle, stubNetwork, el, click, throwInPage } from './helpers/sdk';

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  clearStorage();
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('init', () => {
  it('starts synchronously, sends a v2 batch with the ctx, and fetches config from the CDN without a preflight', async () => {
    const net = await boot({ service: 'web', env: 'production', version: '1.4.2' });
    expect(net.configCalls).toHaveLength(1);
    const [{ url, init }] = net.configCalls;
    expect(url).toBe(`https://cdn.test/rum/config/v2/${APP}.json`);
    expect(init?.credentials).toBe('omit');
    expect(init?.headers).toBeUndefined();
    await flush();
    const [batch] = net.batches;
    expect(batch.url).toBe('https://in.test/v2/batch');
    expect(batch.headers.Authorization).toBe('Bearer ct_1');
    expect(batch.body).toMatchObject({ v: 2, sdk: VERSION });
    expect(batch.body.ctx).toMatchObject({
      service: 'web',
      env: 'production',
      release: '1.4.2',
      consent: 'granted',
      sampling: { analyze: false, replay: false },
      lang: navigator.language,
    });
    expect(batch.body.ctx.session_id).toMatch(UUID7);
    expect(batch.body.ctx.window_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch.body.ctx.page_load_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch.body.ctx.anonymous_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch.body.ctx.viewport).toEqual([innerWidth, innerHeight]);
    expect(batch.body.events.map((e) => e.k)).toEqual(['view_start', 'view_end']);
  });

  it('sends to https://in.siteqwality.com/v2/batch by default', async () => {
    const net = stubNetwork();
    SiteQwalityRUM._reset();
    await SiteQwalityRUM.init({ applicationId: APP, clientToken: 'ct_1', configBase: 'https://cdn.test' });
    await flush();
    expect(net.batches[0].url).toBe('https://in.siteqwality.com/v2/batch');
  });

  it('is idempotent and never throws on bad options', async () => {
    SiteQwalityRUM._reset();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(SiteQwalityRUM.init(null as never)).resolves.toBeUndefined();
    await expect(SiteQwalityRUM.init({ applicationId: '', clientToken: 'x' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const net = await boot();
    await SiteQwalityRUM.init({ applicationId: 'other', clientToken: 'y' });
    expect(net.configCalls).toHaveLength(1);
  });

  it('methods before init are ignored, except opt-out which persists', () => {
    SiteQwalityRUM._reset();
    expect(() => SiteQwalityRUM.setUser({ id: 'u' })).not.toThrow();
    expect(SiteQwalityRUM.getStatus()).toBeUndefined();
    expect(SiteQwalityRUM.getSessionUrl()).toBe('');
    SiteQwalityRUM.optOut();
    expect(SiteQwalityRUM.isOptedOut()).toBe(true);
    SiteQwalityRUM.optIn();
    expect(SiteQwalityRUM.isOptedOut()).toBe(false);
  });

  it('caches the config and uses it on the next page load before the fetch answers', async () => {
    await boot({}, stubNetwork(config({ rules: [rule('analyze')] })));
    expect(JSON.parse(localStorage.getItem(`_sq_cfg_${APP}`)!).c.rules).toHaveLength(1);
    const net = stubNetwork('hang');
    SiteQwalityRUM._reset();
    void SiteQwalityRUM.init({ applicationId: APP, clientToken: 'ct_1', ingestBase: 'https://in.test', configBase: 'https://cdn.test' });
    await settle(2);
    expect(SiteQwalityRUM.getStatus()?.sampled.analyze).toBe(true);
    expect(net.configCalls).toHaveLength(1);
  });

  it('a paused app sends nothing', async () => {
    const net = await boot({}, stubNetwork({ v: 2, status: 'paused' }));
    SiteQwalityRUM.addAction('x');
    await flush();
    pagehide();
    await settle();
    expect(net.batches.flatMap((b) => b.body.events.filter((e) => e.k === 'custom'))).toEqual([]);
  });
});

describe('Observe and Analyze', () => {
  it('sends Observe events at once and buffers Analyze events until a rule matches', async () => {
    const net = await boot({}, stubNetwork(config({ rules: [rule('analyze', [{ kind: 'event', name: 'checkout' }])] })));
    const button = el('<button id="buy">Buy</button>');
    button.addEventListener('click', () => button.classList.toggle('on'));
    click(button);
    await new Promise((r) => setTimeout(r, 1100));
    await flush();
    expect(net.events('action')).toEqual([]);
    expect(SiteQwalityRUM.getStatus()?.sampled.analyze).toBe(false);
    SiteQwalityRUM.addAction('checkout');
    await flush();
    const actions = net.events('action');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action_type: 'click', name: 'Buy', selector: '#buy' });
    expect(net.events('custom')[0]).toMatchObject({ name: 'checkout' });
    expect(net.batches.at(-1)!.body.ctx.sampling).toMatchObject({ analyze: true, rule_id: 'r_analyze_1' });
    button.remove();
  });

  it('keeps the rule decision for the session across page loads in the cookie', async () => {
    await boot({}, stubNetwork(config({ rules: [rule('analyze')] })));
    const first = SiteQwalityRUM.getStatus()!;
    expect(first.sampled).toMatchObject({ analyze: true, rule_id: 'r_analyze_0' });
    expect(document.cookie).toContain(`_sq_s=${first.session_id}|`);
    await boot({}, stubNetwork(config({ rules: [] })));
    const second = SiteQwalityRUM.getStatus()!;
    expect(second.session_id).toBe(first.session_id);
    expect(second.sampled.analyze).toBe(true);
  });

  it('an error rule matches errors raised before the config arrived', async () => {
    const net = stubNetwork('hang');
    SiteQwalityRUM._reset();
    void SiteQwalityRUM.init({ applicationId: APP, clientToken: 'ct_1', ingestBase: 'https://in.test', configBase: 'https://cdn.test' });
    SiteQwalityRUM.addError(new Error('early'));
    expect(SiteQwalityRUM.getStatus()?.sampled.analyze).toBe(false);
    // The config arrives on a later visible refresh.
    net.config = config({ rules: [rule('analyze', [{ kind: 'error' }])] });
    SiteQwalityRUM._reset();
    await boot({}, net);
    expect(SiteQwalityRUM.getStatus()?.sampled.analyze).toBe(false);
  });
});

describe('errors', () => {
  it('sends an error with type, message, stack, handling and error_key within a second', async () => {
    const net = await boot();
    throwInPage(new TypeError('x is null'));
    await new Promise((r) => setTimeout(r, 1100));
    await settle();
    const [e] = net.events('error');
    expect(e).toMatchObject({ error_type: 'TypeError', message: 'x is null', handling: 'unhandled', repeat: 1 });
    expect(typeof e.error_key).toBe('number');
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('drops browser noise and counts it in a status event', async () => {
    const net = await boot();
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    await flush();
    expect(net.events('error')).toEqual([]);
    const status = net.events('status').find((s) => s.counters);
    expect(status?.counters).toMatchObject({ noise_n1: 1, noise_n2: 1 });
    expect(SiteQwalityRUM.getStatus()?.dropped).toMatchObject({ noise_n1: 1, noise_n2: 1 });
  });

  it('scrubs PII from messages at the Balanced default and minimises URLs', async () => {
    const net = await boot();
    SiteQwalityRUM.addError(new Error('no account for jane@example.com at https://x.test/reset?token=abc'));
    await flush();
    expect(net.events('error')[0].message).toBe('no account for <email> at https://x.test/reset');
  });

  it('serialises non-Error rejections and addError values', async () => {
    const net = await boot();
    const reject = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(reject, 'reason', { value: { code: 'E1', n: 42 } });
    window.dispatchEvent(reject);
    SiteQwalityRUM.addError('plain string');
    await flush();
    expect(net.events('error').map((e) => [e.error_type, e.message, e.handling])).toEqual([
      ['UnhandledRejection', '{"code":"E1","n":42}', 'unhandledrejection'],
      ['Error', 'plain string', 'handled'],
    ]);
  });

  it('sends the cause chain, context and a custom fingerprint', async () => {
    const net = await boot();
    SiteQwalityRUM.addError(new Error('outer', { cause: new RangeError('inner') }), { step: 'pay', 'sq.fingerprint': 'checkout-timeout' });
    await flush();
    const [e] = net.events('error');
    expect(e.cause).toEqual([{ type: 'RangeError', message: 'inner', stack: expect.any(String) }]);
    expect(e.context).toEqual({ step: 'pay' });
    expect(e.fingerprint).toBe('checkout-timeout');
  });
});

describe('consent and privacy signals', () => {
  it('pending consent collects in memory and sends or stores nothing until granted', async () => {
    const net = await boot({ trackingConsent: 'pending' });
    SiteQwalityRUM.addAction('a');
    await flush();
    expect(net.batches).toEqual([]);
    expect(document.cookie).not.toContain('_sq_s=');
    expect(localStorage.getItem('_sq_aid')).toBeNull();
    expect(SiteQwalityRUM.getStatus()?.consent).toBe('pending');
    SiteQwalityRUM.setTrackingConsent('granted');
    await flush();
    expect(net.events('custom').map((e) => e.name)).toEqual(['a']);
    expect(document.cookie).toContain('_sq_s=');
    expect(net.batches.at(-1)!.body.ctx.consent).toBe('granted');
  });

  it('not-granted drops everything and clears storage', async () => {
    const net = await boot();
    expect(document.cookie).toContain('_sq_s=');
    SiteQwalityRUM.setTrackingConsent('not-granted');
    SiteQwalityRUM.addAction('a');
    await flush();
    expect(net.events('custom')).toEqual([]);
    expect(document.cookie).not.toContain('_sq_s=');
    expect(localStorage.getItem(`_sq_cfg_${APP}`)).toBeNull();
  });

  it('opt-out stops sending and persists', async () => {
    const net = await boot();
    SiteQwalityRUM.optOut();
    SiteQwalityRUM.addAction('a');
    await flush();
    expect(net.events('custom')).toEqual([]);
    expect(localStorage.getItem('_sq_optout')).toBe('1');
    await boot({}, net);
    expect(SiteQwalityRUM.isOptedOut()).toBe(true);
  });

  it('GPC means no Analyze, no anonymous id, no user and a tab-only session', async () => {
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { globalPrivacyControl: true }));
    const net = await boot({}, stubNetwork(config({ rules: [rule('analyze')] })));
    SiteQwalityRUM.setUser({ id: 'u1' });
    SiteQwalityRUM.addAction('a');
    await flush();
    const ctx = net.batches.at(-1)!.body.ctx;
    expect(ctx.anonymous_id).toBeUndefined();
    expect(ctx.user).toBeUndefined();
    expect(ctx.sampling).toMatchObject({ analyze: false });
    expect(document.cookie).not.toContain('_sq_s=');
    expect(sessionStorage.getItem('_sq_s')).toContain(ctx.session_id);
  });
});

describe('user and attributes', () => {
  it('rides on the ctx; email follows capture_user_email', async () => {
    const net = await boot({}, stubNetwork(config({ privacy: { capture_user_email: false } })));
    SiteQwalityRUM.setUser({ id: 42 as unknown as string, email: 'j@x.test', name: 'Jane', traits: { plan: 'pro', n: 1 as unknown as string } });
    SiteQwalityRUM.setGlobalAttribute('experiment', 'b');
    SiteQwalityRUM.addAction('a');
    await flush();
    const ctx = net.batches.at(-1)!.body.ctx;
    expect(ctx.user).toEqual({ id: '42', name: 'Jane', traits: { plan: 'pro' } });
    expect(ctx.attrs).toEqual({ experiment: 'b' });
  });

  it('caps global attributes: 50 keys, 1024-char values, 4 KB in all', async () => {
    const net = await boot();
    for (let i = 0; i < 60; i++) SiteQwalityRUM.setGlobalAttribute(`k${i}`, 'v');
    SiteQwalityRUM.setGlobalAttribute('big', 'x'.repeat(5000));
    SiteQwalityRUM.removeGlobalAttribute('k0');
    SiteQwalityRUM.addAction('probe');
    await flush();
    const attrs = net.batches.at(-1)!.body.ctx.attrs as Record<string, string>;
    expect(Object.keys(attrs)).toHaveLength(49);
    expect(attrs.k0).toBeUndefined();
  });
});

describe('beforeSend', () => {
  it('runs for every kind, may drop or edit, never changes ids, and re-sanitises', async () => {
    const seen: string[] = [];
    const net = await boot({
      beforeSend: (e, kind) => {
        seen.push(kind);
        if (kind === 'custom' && e.name === 'drop me') return false;
        if (kind === 'error') return { ...e, message: 'edited https://x.test/?token=1', id: 'nope', t: 1 };
        if (kind === 'view') return null;
        return undefined;
      },
    });
    SiteQwalityRUM.addAction('drop me');
    SiteQwalityRUM.addAction('keep');
    SiteQwalityRUM.addError(new Error('original'));
    await flush();
    expect(new Set(seen)).toEqual(new Set(['view', 'custom', 'error']));
    expect(net.events('custom').map((e) => e.name)).toEqual(['keep']);
    const [error] = net.events('error');
    expect(error.message).toBe('edited https://x.test/');
    expect(error.id).not.toBe('nope');
    expect(error.t).not.toBe(1);
    // Views can be edited but not dropped.
    expect(net.events('view_start')).toHaveLength(1);
    expect(SiteQwalityRUM.getStatus()?.dropped.before_send_dropped).toBe(1);
  });

  it('a throwing hook sends the original', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const net = await boot({
      beforeSend: () => {
        throw new Error('hook bug');
      },
    });
    SiteQwalityRUM.addAction('a');
    await flush();
    expect(net.events('custom')).toHaveLength(1);
  });
});

describe('status and support', () => {
  it('getStatus and getSessionUrl', async () => {
    await boot();
    const s = SiteQwalityRUM.getStatus()!;
    expect(s).toMatchObject({ consent: 'granted', opted_out: false, recording: 'off', reason: 'not_sampled', sdk_version: VERSION, config_revision: 7 });
    expect(SiteQwalityRUM.getSessionUrl()).toBe(`https://app.siteqwality.com/rum/${APP}/sessions/${s.session_id}`);
    expect(SiteQwalityRUM.getSessionUrl({ atCurrentTime: true })).toMatch(/\?at=\d{13}$/);
  });
});

describe('page lifecycle', () => {
  it('sends the final view_end uncompressed with keepalive on pagehide', async () => {
    const net = await boot();
    pagehide();
    await settle();
    const last = net.batches.at(-1)!;
    expect(last.gzip).toBe(false);
    expect(last.keepalive).toBe(true);
    const end = last.body.events.find((e) => e.k === 'view_end');
    expect(end).toMatchObject({ final: true, seq: 1 });
  });
});
