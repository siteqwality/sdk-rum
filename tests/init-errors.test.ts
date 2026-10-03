import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import type { RumErrorEvent } from '../src/types';
import {
  errors,
  measures,
  init,
  instance,
  resetSdk,
  serveConfig,
  settle,
  throwInPage,
  ERROR_RULE,
  type Registry,
} from './helpers/harness';

const h = vi.hoisted(() => ({
  transports: [] as Array<{ endpoint: string; events: unknown[] }>,
  replayStart: vi.fn(async () => {}),
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
vi.mock('../src/replay/recorder', () => ({
  ReplayRecorder: class {
    start = h.replayStart;
    stop() {}
  },
}));

const registry = h.transports as Registry;

beforeEach(() => {
  vi.useFakeTimers();
  resetSdk();
  h.transports.length = 0;
  h.replayStart.mockClear();
  history.replaceState({}, '', '/checkout?token=abc#step');
});

afterEach(() => {
  resetSdk();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(extra: Record<string, unknown> = {}, filters: object[] = []) {
  serveConfig(filters);
  await init(extra);
  await settle();
}

describe('browser noise', () => {
  it('drops a ResizeObserver loop error without counting it', async () => {
    await start({}, [ERROR_RULE]);
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }),
    );
    expect(errors(registry)).toHaveLength(0);
    expect(instance().sessionState.hasError).toBe(false);
    expect(h.replayStart).not.toHaveBeenCalled();
  });

  it('drops errors raised by extension code and stackless Script error.', async () => {
    await start();
    const ext = new Error('Failed to fetch');
    ext.stack = 'TypeError: Failed to fetch\n    at chrome-extension://abc/content.js:1:2';
    throwInPage(ext);
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Uncaught Error', filename: 'moz-extension://id/c.js' }),
    );
    expect(errors(registry)).toHaveLength(0);
  });

  it('drops noise passed to addError as well', async () => {
    await start();
    SiteQwalityRUM.addError(new Error('ResizeObserver loop limit exceeded'));
    expect(errors(registry)).toHaveLength(0);
  });
});

describe('a real error', () => {
  it('is sent with its URLs minimised', async () => {
    await start({ version: '1.4.2' });
    const error = new Error('Failed to fetch https://api.example.com/reset?token=s3cret');
    error.stack = 'Error: x\n    at https://shop.example.com/app.js?v=1&sig=abc:1:2';
    throwInPage(error);
    const [event] = errors(registry);
    expect(event.error_message).toBe('Uncaught Error: Failed to fetch https://api.example.com/reset');
    expect(event.error_stack).toBe('Error: x\n    at https://shop.example.com/app.js:1:2');
    expect(event.error_source).toBe('source');
    expect(event.url).toBe('http://localhost:3000/checkout');
    expect(event.version).toBe('1.4.2');
    expect(event.view_id).toBe(instance().currentViewId);
  });

  it('labels an unhandled rejection console, as 1.x did', async () => {
    await start();
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = new TypeError('bad json');
    window.dispatchEvent(rejection);
    const plain = new Event('unhandledrejection') as Event & { reason: unknown };
    plain.reason = 42;
    window.dispatchEvent(plain);
    expect(errors(registry).map((e) => [e.error_message, e.error_source])).toEqual([
      ['bad json', 'console'],
      ['42', 'console'],
    ]);
  });

  it('counts on the next measure only once it is sent', async () => {
    await start({ ignoreErrors: ['ignored'] });
    SiteQwalityRUM.addError(new Error('ignored one'));
    SiteQwalityRUM.addError(new Error('real one'));
    history.pushState({}, '', '/next');
    expect(measures(registry).at(-1)).toMatchObject({ type: 'view', error_count: 1 });
  });

  it('drops a non-string version instead of the whole batch', async () => {
    await start({ version: 7 });
    SiteQwalityRUM.addError(new Error('x'));
    expect(errors(registry)[0]).not.toHaveProperty('version');
  });
});

describe('burst limits', () => {
  it('sends 10 of a burst of 30 identical errors, then one more after 10 s', async () => {
    await start();
    for (let i = 0; i < 30; i++) SiteQwalityRUM.addError(new Error('same'));
    expect(errors(registry)).toHaveLength(10);
    vi.advanceTimersByTime(9_000);
    SiteQwalityRUM.addError(new Error('same'));
    expect(errors(registry)).toHaveLength(10);
    vi.advanceTimersByTime(1_000);
    SiteQwalityRUM.addError(new Error('same'));
    SiteQwalityRUM.addError(new Error('same'));
    expect(errors(registry)).toHaveLength(11);
  });

  it('limits each message on its own, keyed after minimising', async () => {
    await start();
    for (let i = 0; i < 12; i++) {
      SiteQwalityRUM.addError(new Error(`Failed to fetch https://a.example/x?id=${i}`));
    }
    SiteQwalityRUM.addError(new Error('another'));
    expect(errors(registry)).toHaveLength(11);
  });

  it('sends at most 500 errors from one page load', async () => {
    await start();
    for (let i = 0; i < 600; i++) SiteQwalityRUM.addError(new Error(`distinct ${i}`));
    expect(errors(registry)).toHaveLength(500);
  });

  it('a limited error does not count for the session', async () => {
    await start();
    for (let i = 0; i < 15; i++) SiteQwalityRUM.addError(new Error('same'));
    expect(instance().sessionState.errorCount).toBe(10);
  });
});

describe('ignoreErrors', () => {
  it('drops a substring match on the normalized message', async () => {
    await start({ ignoreErrors: ['TypeError: Network'] });
    throwInPage(new TypeError('Network request failed'));
    SiteQwalityRUM.addError(new Error('typeerror: network'));
    expect(errors(registry).map((e) => e.error_message)).toEqual(['typeerror: network']);
  });

  it('drops a RegExp match and leaves the session error-free', async () => {
    await start({ ignoreErrors: [/Loading chunk \d+ failed/] }, [ERROR_RULE]);
    throwInPage(new Error('Loading chunk 17 failed.'));
    expect(errors(registry)).toHaveLength(0);
    expect(instance().sessionState.hasError).toBe(false);
    expect(h.replayStart).not.toHaveBeenCalled();
  });
});

describe('beforeSend', () => {
  it('receives the event and the kind, and can drop it', async () => {
    const beforeSend = vi.fn(() => false as const);
    await start({ beforeSend });
    SiteQwalityRUM.addError(new Error('boom'));
    expect(beforeSend).toHaveBeenCalledWith(expect.objectContaining({ error_message: 'boom' }), 'error');
    expect(errors(registry)).toHaveLength(0);
    expect(instance().sessionState.hasError).toBe(false);
  });

  it('drops on null too', async () => {
    await start({ beforeSend: () => null });
    SiteQwalityRUM.addError(new Error('boom'));
    expect(errors(registry)).toHaveLength(0);
  });

  it('sends changes made in place when it returns nothing', async () => {
    await start({
      beforeSend: (e: RumErrorEvent) => {
        e.error_message = 'scrubbed';
        delete e.user_email;
        e.custom_attributes = { ...e.custom_attributes, tier: 'gold' };
      },
    });
    SiteQwalityRUM.setUser({ id: 'u1', email: 'a@b.c' });
    SiteQwalityRUM.addError(new Error('boom'));
    const [event] = errors(registry);
    expect(event.error_message).toBe('scrubbed');
    expect(event.user_id).toBe('u1');
    expect(event).not.toHaveProperty('user_email');
    expect(event.custom_attributes).toEqual({ tier: 'gold' });
  });

  it('replaces the event with a returned object, keeping ids and time', async () => {
    let seen: RumErrorEvent | undefined;
    await start({
      beforeSend: (e: RumErrorEvent) => {
        seen = { ...e };
        return {
          ...e,
          error_message: 'replaced',
          session_id: 'forged',
          event_id: 'forged',
          view_id: 'forged',
          timestamp: 1,
        };
      },
    });
    SiteQwalityRUM.addError(new Error('boom'));
    const [event] = errors(registry);
    expect(event.error_message).toBe('replaced');
    expect(event.session_id).toBe(seen!.session_id);
    expect(event.event_id).toBe(seen!.event_id);
    expect(event.view_id).toBe(seen!.view_id);
    expect(event.timestamp).toBe(seen!.timestamp);
  });

  it('sends the original, unmodified, when it throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start({
      beforeSend: (e: RumErrorEvent) => {
        e.error_message = 'half done';
        e.custom_attributes!.leaked = 'yes';
        throw new Error('hook bug');
      },
    });
    SiteQwalityRUM.addError(new Error('boom'), { feature: 'cart' });
    const [event] = errors(registry);
    expect(event.error_message).toBe('boom');
    expect(event.custom_attributes).toEqual({ feature: 'cart' });
    expect(warn).toHaveBeenCalled();
  });

  it('minimises URLs the hook puts back', async () => {
    await start({
      beforeSend: (e: RumErrorEvent) => ({
        ...e,
        url: 'https://shop.example.com/reset?token=abc#x',
        error_message: 'see https://shop.example.com/a?email=a@b.c',
        error_stack: 'at https://shop.example.com/app.js?sig=1:1:1',
      }),
    });
    SiteQwalityRUM.addError(new Error('boom'));
    const [event] = errors(registry);
    expect(event.url).toBe('https://shop.example.com/reset');
    expect(event.error_message).toBe('see https://shop.example.com/a');
    expect(event.error_stack).toBe('at https://shop.example.com/app.js:1:1');
  });

  it('reshapes mistyped fields so the batch is still accepted', async () => {
    await start({
      beforeSend: () => ({
        error_message: 42,
        error_source: null,
        user_id: 7,
        custom_attributes: { ok: 'yes', n: 1, nested: { a: 1 } },
      }),
    });
    SiteQwalityRUM.addError(new Error('boom'));
    const [event] = errors(registry);
    expect(event.error_message).toBe('boom');
    expect(event.error_source).toBe('custom');
    expect(event).not.toHaveProperty('user_id');
    expect(event.custom_attributes).toEqual({ ok: 'yes' });
  });

  it('drops an error the hook itself reports, so it cannot loop past the page cap', async () => {
    const beforeSend = vi.fn(() => {
      SiteQwalityRUM.addError(new Error(`nested ${beforeSend.mock.calls.length}`));
    });
    await start({ beforeSend });
    SiteQwalityRUM.addError(new Error('outer'));
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(errors(registry).map((e) => e.error_message)).toEqual(['outer']);
  });

  it('treats a returned promise as no answer and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start({
      beforeSend: async (e: RumErrorEvent) => {
        e.error_message = 'mutated before the await';
        return false;
      },
    });
    SiteQwalityRUM.addError(new Error('a'));
    SiteQwalityRUM.addError(new Error('b'));
    expect(errors(registry).map((e) => e.error_message)).toEqual([
      'mutated before the await',
      'mutated before the await',
    ]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('beforeSend'))).toHaveLength(1);
  });
});

describe('addError accepts any value', () => {
  it('sends a non-Error as String(value) with no stack', async () => {
    await start();
    const values: unknown[] = ['plain string', 42, null, undefined, { a: 1 }, Symbol('s')];
    for (const value of values) SiteQwalityRUM.addError(value);
    SiteQwalityRUM.addError(Object.create(null));
    expect(errors(registry).map((e) => [e.error_message, e.error_stack])).toEqual([
      ['plain string', ''],
      ['42', ''],
      ['null', ''],
      ['undefined', ''],
      ['[object Object]', ''],
      ['Symbol(s)', ''],
      ['[object Object]', ''],
    ]);
  });

  it('reads message and stack from an Error-like object', async () => {
    await start();
    SiteQwalityRUM.addError({ message: 'from an iframe', stack: 'Error\n    at https://a.example/x.js:1:1' });
    expect(errors(registry)[0]).toMatchObject({
      error_message: 'from an iframe',
      error_stack: 'Error\n    at https://a.example/x.js:1:1',
      error_source: 'custom',
    });
  });

  it('keeps only string context values', async () => {
    await start();
    SiteQwalityRUM.addError(new Error('x'), { a: 'b', n: 1 } as unknown as Record<string, string>);
    expect(errors(registry)[0].custom_attributes).toEqual({ a: 'b' });
  });
});

describe('rules', () => {
  it('a sent error matches an error rule at once, with no timer', async () => {
    await start({}, [ERROR_RULE]);
    expect(h.replayStart).not.toHaveBeenCalled();
    SiteQwalityRUM.addError(new Error('boom'));
    expect(instance().detailActive).toBe(true);
    expect(h.replayStart).toHaveBeenCalledTimes(1);
  });
});
