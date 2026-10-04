import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RumErrorEvent } from '../src/types';
import { errors, measures, type Registry } from './helpers/harness';

const h = vi.hoisted(() => ({
  transports: [] as Array<{ endpoint: string; events: unknown[] }>,
}));

vi.mock('../src/transport', () => ({
  TransportManager: class {
    events: unknown[] = [];
    constructor(public endpoint: string) {
      h.transports.push(this);
    }
    enqueue(event: unknown) {
      this.events.push(event);
    }
  },
}));
vi.mock('../src/collectors/vitals', () => ({ startVitalsCollector: vi.fn() }));

const registry = h.transports as Registry;

// The dashboard's canonical snippet (core-rs wave 1 contract, F7), pointing nowhere.
const SNIPPET = `
  (function(w,d,s,u){var r=w.SiteQwalityRUM=w.SiteQwalityRUM||{_q:[]};if(r._q&&!r._h){
  ['init','setUser','setGlobalAttribute','removeGlobalAttribute','addError','addAction'].forEach(function(m){
    r[m]=function(){r._q.push([m,arguments])}});
  r._h=function(e){r._q.push(['_e',[e]])};w.addEventListener('error',r._h);
  w.addEventListener('unhandledrejection',r._h);
  var e=d.createElement(s);e.async=1;e.src=u;(d.head||d.documentElement).appendChild(e)}
  })(window,document,'script','about:blank');
`;

type Global = Record<string, unknown> & {
  SiteQwalityRUM?: Record<string, unknown> & { _q?: unknown[] };
};
const win = window as unknown as Global;

async function loadCdn() {
  await import('../src/cdn');
}

function rejection(reason: unknown): Event {
  const event = new Event('unhandledrejection') as Event & { reason: unknown };
  event.reason = reason;
  return event;
}

function sdk() {
  return win.SiteQwalityRUM as unknown as {
    instance: { context: { getUser(): { id?: string } } } | null;
    addError(e: unknown): void;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  sessionStorage.clear();
  h.transports.length = 0;
  delete win.SiteQwalityRUM;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  history.replaceState({}, '', '/');
});

afterEach(() => {
  const loaded = win.SiteQwalityRUM as { instance?: unknown; detachEarly?: (() => void) | null } | undefined;
  if (loaded && 'instance' in loaded) loaded.instance = null;
  loaded?.detachEarly?.();
  delete win.SiteQwalityRUM;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CDN snippet replay', () => {
  it('replays init, early errors with their original times, then setUser', async () => {
    // eslint-disable-next-line no-new-func
    new Function(SNIPPET)();
    const stub = win.SiteQwalityRUM as unknown as Record<string, (...a: unknown[]) => void>;
    stub.init({ applicationId: 'app-1', clientToken: 'ct_1' });

    const t0 = Date.now();
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Uncaught TypeError: boom', error: new TypeError('boom') }),
    );
    window.dispatchEvent(rejection(new Error('rejected')));
    stub.setUser({ id: 'user_1' });
    expect(win.SiteQwalityRUM!._q).toHaveLength(4);

    vi.advanceTimersByTime(3_000);
    await loadCdn();

    const sent = errors(registry);
    expect(sent.map((e) => [e.error_message, e.error_source])).toEqual([
      ['Uncaught TypeError: boom', 'source'],
      ['rejected', 'console'],
    ]);
    for (const event of sent) expect(event.timestamp).toBe(t0);
    // Queued before setUser, so the early errors carry no user; later events do.
    expect(sent[0]).not.toHaveProperty('user_id');
    expect(sdk().instance!.context.getUser().id).toBe('user_1');
    sdk().addError(new Error('later'));
    expect(errors(registry).at(-1)!.user_id).toBe('user_1');
  });

  it('removes the stub listeners, so later errors are captured once', async () => {
    new Function(SNIPPET)();
    const stub = win.SiteQwalityRUM as unknown as Record<string, (...a: unknown[]) => void> & { _q: unknown[] };
    stub.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    await loadCdn();
    const queued = stub._q.length;
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: after', error: new Error('after') }));
    expect(stub._q).toHaveLength(queued);
    expect(errors(registry).map((e) => e.error_message)).toEqual(['Uncaught Error: after']);
  });

  it('converts a high-resolution event time to epoch milliseconds', async () => {
    vi.setSystemTime(performance.timeOrigin + 60_000);
    new Function(SNIPPET)();
    const stub = win.SiteQwalityRUM as unknown as Record<string, (...a: unknown[]) => void>;
    stub.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    const event = new ErrorEvent('error', { message: 'Uncaught Error: hr', error: new Error('hr') });
    Object.defineProperty(event, 'timeStamp', { value: 5.4 });
    window.dispatchEvent(event);
    await loadCdn();
    expect(errors(registry)[0].timestamp).toBe(Math.round(performance.timeOrigin + 5.4));
  });

  it('runs init first even when it was queued after other calls', async () => {
    win.SiteQwalityRUM = {
      _q: [
        ['setUser', [{ id: 'early_user' }]],
        ['addError', [new Error('queued')]],
        ['init', [{ applicationId: 'app-1', clientToken: 'ct_1' }]],
      ],
    };
    await loadCdn();
    expect(sdk().instance!.context.getUser().id).toBe('early_user');
    expect(errors(registry).map((e) => [e.error_message, e.user_id])).toEqual([['queued', 'early_user']]);
  });

  it('skips bad entries and keeps going', async () => {
    const throwing = { get message(): string { throw new Error('getter'); } };
    win.SiteQwalityRUM = {
      _q: [
        'garbage',
        null,
        ['nope', []],
        ['_captureEarly', [{}]],
        ['init', [{ applicationId: 'app-1', clientToken: 'ct_1' }]],
        ['_e', [null]],
        ['_e', [throwing]],
        ['addError', [new Error('still sent')]],
        ['setUser'],
      ],
    };
    await loadCdn();
    expect(errors(registry).map((e) => e.error_message)).toContain('still sent');
  });

  it('accepts arguments objects, as the snippet queues them', async () => {
    win.SiteQwalityRUM = { _q: [] };
    const q = win.SiteQwalityRUM._q!;
    (function (..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      q.push(['init', arguments]);
    })({ applicationId: 'app-1', clientToken: 'ct_1' });
    await loadCdn();
    expect(measures(registry)).toHaveLength(1);
  });

  it('forwards calls made on a kept reference to the stub', async () => {
    new Function(SNIPPET)();
    const stub = win.SiteQwalityRUM as unknown as Record<string, (...a: unknown[]) => void>;
    stub.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    await loadCdn();
    expect(win.SiteQwalityRUM).not.toBe(stub);
    stub.addError(new Error('via the old reference'));
    expect(errors(registry).map((e) => e.error_message)).toEqual(['via the old reference']);
  });

  it('still accepts the 1.0.x snippet stub, which has no error listener', async () => {
    document.head.appendChild(document.createElement('script'));
    new Function(`
      (function(w,d,s,c,t){w.SiteQwalityRUM=w.SiteQwalityRUM||{_q:[]};
      ['init','setUser','addError','addAction'].forEach(function(m){
        w.SiteQwalityRUM[m]=function(){w.SiteQwalityRUM._q.push([m,arguments])}
      });var e=d.createElement(s);e.async=1;
      e.src='about:blank';
      d.getElementsByTagName(s)[0].parentNode.insertBefore(e,d.getElementsByTagName(s)[0]);
      })(window,document,'script');
      SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
      SiteQwalityRUM.addError(new Error('queued in 1.0.x'));
    `)();
    await loadCdn();
    expect(measures(registry)).toHaveLength(1);
    expect(errors(registry).map((e) => e.error_message)).toEqual(['queued in 1.0.x']);
  });

  it('works with no stub at all', async () => {
    await loadCdn();
    expect(typeof (win.SiteQwalityRUM as { init?: unknown }).init).toBe('function');
    expect((win.SiteQwalityRUM as { __sq?: unknown }).__sq).toBe(true);
  });

  it('is a no-op when the script loads twice', async () => {
    win.SiteQwalityRUM = { _q: [['init', [{ applicationId: 'app-1', clientToken: 'ct_1' }]]] };
    await loadCdn();
    const first = win.SiteQwalityRUM;
    const created = h.transports.length;
    vi.resetModules();
    await loadCdn();
    expect(win.SiteQwalityRUM).toBe(first);
    expect(h.transports.length).toBe(created);
  });

  it('keeps early errors when init is not in the queue, until init runs', async () => {
    win.SiteQwalityRUM = { _q: [['_e', [new ErrorEvent('error', { message: 'Uncaught Error: e', error: new Error('e') })]]] };
    await loadCdn();
    expect(errors(registry)).toHaveLength(0);
    void (win.SiteQwalityRUM as unknown as { init(o: unknown): Promise<void> }).init({
      applicationId: 'app-1',
      clientToken: 'ct_1',
    });
    expect(errors(registry).map((e: RumErrorEvent) => e.error_message)).toEqual(['Uncaught Error: e']);
  });

  it('keeps catching page errors between the script load and a deferred init', async () => {
    // A consent banner holds init back: the snippet ran without its init call.
    new Function(SNIPPET)();
    expect(win.SiteQwalityRUM!._q).toHaveLength(0);
    await loadCdn();
    const t0 = Date.now();
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: while waiting', error: new Error('while waiting') }));
    vi.advanceTimersByTime(2_000);
    expect(errors(registry)).toHaveLength(0);

    void (win.SiteQwalityRUM as unknown as { init(o: unknown): Promise<void> }).init({ applicationId: 'app-1', clientToken: 'ct_1' });
    expect(errors(registry).map((e) => [e.error_message, e.timestamp])).toEqual([['Uncaught Error: while waiting', t0]]);

    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: after init', error: new Error('after init') }));
    expect(errors(registry).map((e) => e.error_message)).toEqual(['Uncaught Error: while waiting', 'Uncaught Error: after init']);
  });

  it('falls back to the current time for an implausible event time', async () => {
    new Function(SNIPPET)();
    const stub = win.SiteQwalityRUM as unknown as Record<string, (...a: unknown[]) => void>;
    stub.init({ applicationId: 'app-1', clientToken: 'ct_1' });
    for (const value of [-1, Number.NaN, 10 ** 15]) {
      const event = new ErrorEvent('error', { message: `Uncaught Error: ${value}`, error: new Error(String(value)) });
      Object.defineProperty(event, 'timeStamp', { value });
      window.dispatchEvent(event);
    }
    await loadCdn();
    for (const event of errors(registry)) expect(event.timestamp).toBe(Date.now());
  });
});
