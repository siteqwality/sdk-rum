import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM, PRE_CONFIG_BUFFER_MAX } from '../src/init';
import { startResourceCollector } from '../src/collectors/resources';
import { startLongTaskCollector } from '../src/collectors/long-tasks';
import {
  click,
  details,
  el,
  errors,
  holdConfig,
  init,
  instance,
  measures,
  resetSdk,
  serveConfig,
  settle,
  throwInPage,
  MATCH_ALL,
  type Registry,
} from './helpers/harness';

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
vi.mock('../src/collectors/long-tasks', () => ({ startLongTaskCollector: vi.fn() }));
vi.mock('../src/collectors/resources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/collectors/resources')>()),
  startResourceCollector: vi.fn(),
}));
vi.mock('../src/replay/recorder', () => ({
  ReplayRecorder: class {
    async start() {}
    stop() {}
  },
}));

const registry = h.transports as Registry;

beforeEach(() => {
  vi.useFakeTimers();
  resetSdk();
  h.transports.length = 0;
  vi.mocked(startResourceCollector).mockClear();
  vi.mocked(startLongTaskCollector).mockClear();
  history.replaceState({}, '', '/');
  document.body.innerHTML = '';
});

afterEach(() => {
  resetSdk();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function emitResource(url: string) {
  const onResource = vi.mocked(startResourceCollector).mock.calls.at(-1)![0];
  onResource({ resource_type: 'fetch', resource_url: url, duration_ms: 12, transfer_size: 0 });
}

function emitLongTask(ms: number) {
  vi.mocked(startLongTaskCollector).mock.calls.at(-1)![0](ms);
}

describe('synchronous start', () => {
  it('queues the initial view before init resolves', () => {
    holdConfig();
    void init();
    expect(measures(registry)).toHaveLength(1);
    expect(measures(registry)[0]).toMatchObject({ type: 'view', loading_type: 'initial_load' });
  });

  it('addError right after init does not throw and is queued while config is pending', () => {
    holdConfig();
    void init();
    expect(() => SiteQwalityRUM.addError(new Error('boom'))).not.toThrow();
    expect(errors(registry).map((e) => e.error_message)).toEqual(['boom']);
  });

  it('sends an error thrown before the config arrives', () => {
    holdConfig();
    void init();
    throwInPage(new TypeError('early'));
    expect(errors(registry)).toHaveLength(1);
  });

  it('resolves init once the config is applied', async () => {
    const release = holdConfig([MATCH_ALL]);
    let resolved = false;
    void init().then(() => (resolved = true));
    await settle();
    expect(resolved).toBe(false);
    release();
    await settle();
    expect(resolved).toBe(true);
    expect(instance().detailActive).toBe(true);
  });

  it('resolves within the timeout even if fetch never settles', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    let resolved = false;
    void init().then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolved).toBe(true);
    expect(instance().configReady).toBe(true);
  });
});

describe('pre-config buffer', () => {
  it('holds a resource until config, then sends it when a rule matches', async () => {
    const release = holdConfig([MATCH_ALL]);
    void init();
    emitResource('https://api.example.com/a');
    expect(details(registry)).toHaveLength(0);
    release();
    await settle();
    expect(details(registry).map((e) => e.resource_url)).toEqual(['https://api.example.com/a']);
  });

  it('drops the buffer when no rule matches', async () => {
    const release = holdConfig([]);
    void init();
    emitResource('https://api.example.com/a');
    emitLongTask(120);
    release();
    await settle();
    expect(details(registry)).toHaveLength(0);
    expect(instance().preConfig).toHaveLength(0);
  });

  it('applies the config resource exclusions to buffered resources', async () => {
    const release = holdConfig([MATCH_ALL], { resource_exclusions: ['https://api.example.com/poll'] });
    void init();
    emitResource('https://api.example.com/poll');
    emitResource('https://api.example.com/poll/1');
    emitResource('https://api.example.com/data');
    release();
    await settle();
    expect(details(registry).map((e) => e.resource_url)).toEqual(['https://api.example.com/data']);
  });

  it('strips element text from buffered clicks when the config hides it', async () => {
    const release = holdConfig([MATCH_ALL], {
      privacy: { mask_inputs: true, mask_text: false, hide_action_text: true },
    });
    void init();
    click(el('<button class="send">Pay Jane Doe</button>'));
    vi.advanceTimersByTime(1_000);
    release();
    await settle();
    expect(details(registry).map((e) => e.action_target)).toEqual(['button.send']);
  });

  it('keeps element text when the config allows it', async () => {
    const release = holdConfig([MATCH_ALL]);
    void init();
    click(el('<button class="send">Pay</button>'));
    vi.advanceTimersByTime(1_000);
    release();
    await settle();
    expect(details(registry).map((e) => e.action_target)).toEqual(['button.send[Pay]']);
  });

  it(`keeps the newest ${PRE_CONFIG_BUFFER_MAX} events`, async () => {
    const release = holdConfig([MATCH_ALL]);
    void init();
    for (let i = 0; i < PRE_CONFIG_BUFFER_MAX + 20; i++) emitResource(`https://a.example/${i}`);
    release();
    await settle();
    const urls = details(registry).map((e) => e.resource_url);
    expect(urls).toHaveLength(PRE_CONFIG_BUFFER_MAX);
    expect(urls[0]).toBe('https://a.example/20');
  });

  it('sends errors and measures at once, never buffered', () => {
    holdConfig([MATCH_ALL]);
    void init();
    SiteQwalityRUM.addError(new Error('x'));
    history.pushState({}, '', '/other');
    expect(errors(registry)).toHaveLength(1);
    expect(measures(registry)).toHaveLength(2);
  });

  it('after config, detail goes straight out', async () => {
    serveConfig([MATCH_ALL]);
    await init();
    await settle();
    emitResource('https://api.example.com/a');
    expect(details(registry)).toHaveLength(1);
  });
});

describe('public methods never throw', () => {
  const garbage: unknown[] = [undefined, null, 0, NaN, '', 'x', {}, [], Symbol('s'), () => {}, Object.create(null)];

  function callEverything() {
    const api = SiteQwalityRUM as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const value of garbage) {
      for (const method of ['setUser', 'setGlobalAttribute', 'removeGlobalAttribute', 'addError', 'addAction']) {
        expect(() => api[method](value, value)).not.toThrow();
      }
      expect(() => api._captureEarly(value)).not.toThrow();
    }
  }

  it('before init', () => {
    callEverything();
    expect(errors(registry)).toHaveLength(0);
  });

  it('after init', async () => {
    serveConfig([MATCH_ALL]);
    await init();
    await settle();
    callEverything();
  });

  it('init with bad options warns, resolves, and leaves room for a good init', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveConfig();
    for (const value of garbage) {
      await expect(SiteQwalityRUM.init(value as never)).resolves.toBeUndefined();
    }
    await expect(SiteQwalityRUM.init({ applicationId: 'app-1' } as never)).resolves.toBeUndefined();
    expect(instance()).toBeNull();
    expect(warn).toHaveBeenCalled();
    await init();
    expect(instance()?.started).toBe(true);
  });

  it('an internal failure in a collector callback stays inside the SDK', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveConfig([MATCH_ALL]);
    await init();
    await settle();
    instance().eventTransport.enqueue = () => {
      throw new Error('internal');
    };
    expect(() => emitResource('https://a.example/x')).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
