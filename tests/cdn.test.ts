import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PUBLIC_METHODS } from '../src/api';
import { clearStorage, flush, stubNetwork, type Net } from './helpers/sdk';

// The dashboard snippet stub for 2.0 (F7 plus the 2.0 method names), pointing nowhere.
const SNIPPET = `
  (function(w,d,s,u){var r=w.SiteQwalityRUM=w.SiteQwalityRUM||{_q:[]};if(r._q&&!r._h){
  ${JSON.stringify(PUBLIC_METHODS)}.forEach(function(m){
    r[m]=function(){r._q.push([m,arguments])}});
  r._h=function(e){r._q.push(['_e',[e]])};w.addEventListener('error',r._h);
  w.addEventListener('unhandledrejection',r._h);
  var e=d.createElement(s);e.async=1;e.src=u;(d.head||d.documentElement).appendChild(e)}
  })(window,document,'script','about:blank');
`;

const OPTIONS = { applicationId: 'app-1', clientToken: 'ct_1', ingestBase: 'https://in.test', configBase: 'https://cdn.test' };

type Global = Record<string, unknown> & { SiteQwalityRUM?: Record<string, unknown> & { _q?: unknown[] } };
const win = window as unknown as Global;
let net: Net;

async function loadCdn() {
  await import('../src/cdn');
}

const api = () => win.SiteQwalityRUM as unknown as Record<string, (...a: unknown[]) => unknown> & { _reset(): void };
const stub = () => win.SiteQwalityRUM as unknown as Record<string, (...a: unknown[]) => void> & { _q: unknown[] };

function rejection(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection'), { reason });
}

async function sentErrors() {
  await flush();
  return net.events('error');
}

beforeEach(() => {
  vi.resetModules();
  clearStorage();
  delete win.SiteQwalityRUM;
  net = stubNetwork();
});

afterEach(() => {
  try {
    api()?._reset?.();
  } catch {
    // Not loaded.
  }
  delete win.SiteQwalityRUM;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CDN snippet replay', () => {
  it('replays init, early errors with their original times, then setUser', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    new Function(SNIPPET)();
    stub().init(OPTIONS);
    const t0 = Date.now();
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught TypeError: boom', error: new TypeError('boom') }));
    window.dispatchEvent(rejection(new Error('rejected')));
    stub().setUser({ id: 'user_1' });
    expect(win.SiteQwalityRUM!._q).toHaveLength(4);
    vi.advanceTimersByTime(3_000);
    await loadCdn();
    const sent = await sentErrors();
    expect(sent.map((e) => [e.error_type, e.message, e.handling])).toEqual([
      ['TypeError', 'boom', 'unhandled'],
      ['Error', 'rejected', 'unhandledrejection'],
    ]);
    for (const e of sent) expect(e.t).toBe(t0);
    expect(net.batches.at(-1)!.body.ctx.user).toEqual({ id: 'user_1' });
  });

  it('queues and replays every 2.0 method, init first', async () => {
    win.SiteQwalityRUM = {
      _q: [
        ['setGlobalAttribute', ['plan', 'pro']],
        ['addAction', ['queued-action']],
        ['setView', ['Home']],
        ['init', [OPTIONS]],
      ],
    };
    await loadCdn();
    await flush();
    expect(net.events('custom').map((e) => e.name)).toEqual(['queued-action']);
    expect(net.events('view_start')[0].route).toBe('Home');
    expect(net.batches.at(-1)!.body.ctx.attrs).toEqual({ plan: 'pro' });
  });

  it('removes the stub listeners, so later errors are captured once', async () => {
    new Function(SNIPPET)();
    stub().init(OPTIONS);
    await loadCdn();
    const queued = stub()._q?.length ?? 0;
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: after', error: new Error('after') }));
    expect(stub()._q?.length ?? 0).toBe(queued);
    expect((await sentErrors()).map((e) => e.message)).toEqual(['after']);
  });

  it('converts a high-resolution event time to epoch milliseconds', async () => {
    new Function(SNIPPET)();
    stub().init(OPTIONS);
    const event = new ErrorEvent('error', { message: 'Uncaught Error: hr', error: new Error('hr') });
    Object.defineProperty(event, 'timeStamp', { value: 5.4 });
    window.dispatchEvent(event);
    await loadCdn();
    expect((await sentErrors())[0].t).toBe(Math.round(performance.timeOrigin + 5.4));
  });

  it('skips bad entries and keeps going', async () => {
    const throwing = { get message(): string { throw new Error('getter'); } };
    win.SiteQwalityRUM = {
      _q: ['garbage', null, ['nope', []], ['_captureEarly', [{}]], ['init', [OPTIONS]], ['_e', [null]], ['_e', [throwing]], ['addError', [new Error('still sent')]], ['setUser']],
    };
    await loadCdn();
    expect((await sentErrors()).map((e) => e.message)).toContain('still sent');
  });

  it('accepts arguments objects, as the snippet queues them', async () => {
    win.SiteQwalityRUM = { _q: [] };
    const q = win.SiteQwalityRUM._q!;
    (function (..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      q.push(['init', arguments]);
    })(OPTIONS);
    await loadCdn();
    await flush();
    expect(net.events('view_start')).toHaveLength(1);
  });

  it('forwards calls made on a kept reference to the stub, return values included', async () => {
    new Function(SNIPPET)();
    const kept = stub();
    kept.init(OPTIONS);
    await loadCdn();
    expect(win.SiteQwalityRUM).not.toBe(kept);
    kept.addError(new Error('via the old reference'));
    expect((kept.getSessionUrl as unknown as () => string)()).toMatch(/\/rum\/app-1\/sessions\//);
    expect((await sentErrors()).map((e) => e.message)).toEqual(['via the old reference']);
  });

  it('still accepts the 1.0.x snippet stub, which has no error listener', async () => {
    document.head.appendChild(document.createElement('script'));
    new Function(`
      (function(w,d,s){w.SiteQwalityRUM=w.SiteQwalityRUM||{_q:[]};
      ['init','setUser','addError','addAction'].forEach(function(m){
        w.SiteQwalityRUM[m]=function(){w.SiteQwalityRUM._q.push([m,arguments])}
      });var e=d.createElement(s);e.async=1;e.src='about:blank';
      d.getElementsByTagName(s)[0].parentNode.insertBefore(e,d.getElementsByTagName(s)[0]);
      })(window,document,'script');
      SiteQwalityRUM.init(${JSON.stringify(OPTIONS)});
      SiteQwalityRUM.addError(new Error('queued in 1.0.x'));
    `)();
    await loadCdn();
    expect((await sentErrors()).map((e) => e.message)).toEqual(['queued in 1.0.x']);
  });

  it('works with no stub at all', async () => {
    await loadCdn();
    expect(typeof api().init).toBe('function');
    expect(api().__sq).toBe(true);
  });

  it('is a no-op when the script loads twice', async () => {
    win.SiteQwalityRUM = { _q: [['init', [OPTIONS]]] };
    await loadCdn();
    const first = win.SiteQwalityRUM;
    vi.resetModules();
    await loadCdn();
    expect(win.SiteQwalityRUM).toBe(first);
    expect(net.configCalls).toHaveLength(1);
  });

  it('keeps catching page errors between the script load and a deferred init', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    new Function(SNIPPET)();
    await loadCdn();
    const t0 = Date.now();
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: while waiting', error: new Error('while waiting') }));
    vi.advanceTimersByTime(2_000);
    void api().init(OPTIONS);
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: after init', error: new Error('after init') }));
    const sent = await sentErrors();
    expect(sent.map((e) => [e.message, e.t === t0])).toEqual([
      ['while waiting', true],
      ['after init', false],
    ]);
  });

  it('falls back to the current time for an implausible event time', async () => {
    new Function(SNIPPET)();
    stub().init(OPTIONS);
    for (const value of [-1, Number.NaN, 10 ** 15]) {
      const event = new ErrorEvent('error', { message: `Uncaught Error: ${value}`, error: new Error(String(value)) });
      Object.defineProperty(event, 'timeStamp', { value });
      window.dispatchEvent(event);
    }
    const before = Date.now();
    await loadCdn();
    for (const e of await sentErrors()) expect(Number(e.t)).toBeGreaterThanOrEqual(before);
  });
});
