import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import { startVitalsCollector } from '../src/collectors/vitals';
import { startResourceCollector } from '../src/collectors/resources';
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
  MATCH_ALL,
  MATCH_ALL_REPLAY,
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
vi.mock('../src/collectors/resources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/collectors/resources')>()),
  startResourceCollector: vi.fn(),
}));
// Per instance: earlier tests' instances still listen on window.
vi.mock('../src/replay/recorder', () => ({
  ReplayRecorder: class {
    start = vi.fn(async () => {});
    stop = vi.fn();
  },
}));

const registry = h.transports as Registry;
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  resetSdk();
  h.transports.length = 0;
  vi.mocked(startVitalsCollector).mockClear();
  vi.mocked(startResourceCollector).mockClear();
  history.replaceState({}, '', '/home');
  document.body.innerHTML = '';
});

afterEach(() => {
  resetSdk();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(filters: object[] = []) {
  serveConfig(filters);
  await init();
  await settle();
}

function vital(name: string, value: number) {
  vi.mocked(startVitalsCollector).mock.calls.at(-1)![0](name, value);
}

function input(type = 'pointerdown') {
  window.dispatchEvent(new Event(type));
}

const sessionId = () => instance().session.current() as string;

describe('vitals belong to the initial view', () => {
  it('a CLS after 20 idle minutes goes out under the original session and view', async () => {
    await start();
    const [view] = measures(registry);
    vi.advanceTimersByTime(20 * MIN);
    vital('cls', 0.12);
    const last = measures(registry).at(-1)!;
    expect(last).toMatchObject({ type: 'vital', cls: 0.12, session_id: view.session_id, view_id: view.view_id, url: view.url });
    expect(measures(registry).filter((m) => m.type === 'view')).toHaveLength(1);
    expect(sessionId()).toBe(view.session_id);
  });

  it('stay with the initial view after a route change', async () => {
    await start();
    const [view] = measures(registry);
    history.pushState({}, '', '/next');
    vital('inp_ms', 180);
    expect(measures(registry).at(-1)).toMatchObject({ view_id: view.view_id, url: 'http://localhost:3000/home' });
  });

  it('carry the counts the original session still owes', async () => {
    await start();
    click(el('<button>a</button>'));
    vi.advanceTimersByTime(16 * MIN);
    input();
    vital('cls', 0.01);
    const [first] = measures(registry);
    const late = measures(registry).at(-1)!;
    expect(late.session_id).toBe(first.session_id);
    expect(late.action_count).toBe(1);
  });
});

describe('session activity', () => {
  it('input after 16 idle minutes rotates and starts a view in the new session', async () => {
    await start();
    const first = sessionId();
    vi.advanceTimersByTime(16 * MIN);
    input('keydown');
    expect(sessionId()).not.toBe(first);
    const view = measures(registry).at(-1)!;
    expect(view).toMatchObject({ type: 'view', loading_type: 'route_change', session_id: sessionId(), url: 'http://localhost:3000/home' });
    expect(view).not.toHaveProperty('load_time_ms');
  });

  it('SDK emits alone never extend the session', async () => {
    await start();
    const first = sessionId();
    vi.advanceTimersByTime(10 * MIN);
    SiteQwalityRUM.addError(new Error('background'));
    vi.advanceTimersByTime(6 * MIN);
    expect(instance().session.isExpired()).toBe(true);
    SiteQwalityRUM.addError(new Error('later'));
    const [early, late] = errors(registry);
    expect(early.session_id).toBe(first);
    expect(late.session_id).not.toBe(first);
    expect(late.view_id).toBe(measures(registry).at(-1)!.view_id);
  });

  it('input keeps the session alive, throttled to once per 5 s', async () => {
    await start();
    const first = sessionId();
    const touched = vi.spyOn(instance().session, 'activity');
    input();
    input('scroll');
    input('touchstart');
    expect(touched).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    input();
    expect(touched).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(14 * MIN);
    input();
    vi.advanceTimersByTime(14 * MIN);
    input();
    expect(sessionId()).toBe(first);
  });

  it('the tab becoming visible and a view start count as activity', async () => {
    await start();
    const first = sessionId();
    vi.advanceTimersByTime(14 * MIN);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(14 * MIN);
    history.pushState({}, '', '/later');
    vi.advanceTimersByTime(14 * MIN);
    SiteQwalityRUM.addError(new Error('x'));
    expect(errors(registry)[0].session_id).toBe(first);
  });

  it('a route change after idling opens the new session with exactly one view', async () => {
    await start();
    const first = sessionId();
    vi.advanceTimersByTime(16 * MIN);
    history.pushState({}, '', '/after-idle');
    const views = measures(registry).filter((m) => m.type === 'view');
    expect(views).toHaveLength(2);
    expect(views[1]).toMatchObject({ url: 'http://localhost:3000/after-idle', session_id: sessionId() });
    expect(views[1].session_id).not.toBe(first);
  });

  it('an error that beforeSend drops never opens a session', async () => {
    serveConfig();
    await init({ beforeSend: () => false });
    await settle();
    const first = sessionId();
    vi.advanceTimersByTime(16 * MIN);
    SiteQwalityRUM.addError(new Error('dropped by the hook'));
    expect(sessionId()).toBe(first);
    expect(measures(registry).filter((m) => m.type === 'view')).toHaveLength(1);
  });

  it('a kept error in an expired session goes to the new session and its view', async () => {
    let seenSession = '';
    serveConfig();
    await init({ beforeSend: (e: { session_id: string }) => { seenSession = e.session_id; } });
    await settle();
    const first = sessionId();
    vi.advanceTimersByTime(16 * MIN);
    SiteQwalityRUM.addError(new Error('kept'));
    const [event] = errors(registry);
    expect(seenSession).toBe(first);
    expect(event.session_id).toBe(sessionId());
    expect(event.session_id).not.toBe(first);
    expect(event.view_id).toBe(measures(registry).at(-1)!.view_id);
  });

  it('a hidden tab drops errors once its session expired, without rotating', async () => {
    await start();
    const first = sessionId();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      vi.advanceTimersByTime(10 * MIN);
      SiteQwalityRUM.addError(new Error('failing poll'));
      vi.advanceTimersByTime(6 * MIN);
      SiteQwalityRUM.addError(new Error('failing poll'));
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }
    expect(errors(registry).map((e) => e.session_id)).toEqual([first]);
    expect(sessionId()).toBe(first);
    expect(measures(registry).filter((m) => m.type === 'view')).toHaveLength(1);
  });

  it('background resources in an expired session are dropped without rotating', async () => {
    await start([MATCH_ALL]);
    const first = sessionId();
    vi.advanceTimersByTime(16 * MIN);
    vi.mocked(startResourceCollector).mock.calls.at(-1)![0]({
      resource_type: 'fetch',
      resource_url: 'https://a.example/poll',
      duration_ms: 3,
      transfer_size: 0,
    });
    expect(details(registry)).toHaveLength(0);
    expect(sessionId()).toBe(first);
    expect(measures(registry).filter((m) => m.type === 'view')).toHaveLength(1);
  });
});

describe('rotation', () => {
  it('resets state and latches, stops the recorder, then re-evaluates for the new session', async () => {
    await start([MATCH_ALL_REPLAY]);
    const recorder = instance().replayRecorder;
    expect(recorder.start).toHaveBeenCalledTimes(1);
    SiteQwalityRUM.addError(new Error('x'));
    expect(instance().sessionState.hasError).toBe(true);

    vi.advanceTimersByTime(16 * MIN);
    input();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(instance().sessionState).toMatchObject({ hasError: false, errorCount: 0, actionCount: 0 });
    // The match-all rule latches again, and replay restarts under the new id.
    expect(instance().detailActive).toBe(true);
    expect(recorder.start).toHaveBeenCalledTimes(2);
    expect(recorder.start.mock.calls[1][0]).toBe(sessionId());
  });

  it('keeps the user across the rotation', async () => {
    await start([{ filter_type: 'custom', conditions: { has_user: true }, capture_replay: false }]);
    SiteQwalityRUM.setUser({ id: 'u1' });
    vi.advanceTimersByTime(16 * MIN);
    input();
    expect(instance().sessionState.userId).toBe('u1');
    expect(instance().detailActive).toBe(true);
  });

  it('clears the pre-config buffer', async () => {
    holdConfig([MATCH_ALL]);
    void init();
    vi.mocked(startResourceCollector).mock.calls.at(-1)![0]({
      resource_type: 'fetch',
      resource_url: 'https://a.example/x',
      duration_ms: 3,
      transfer_size: 0,
    });
    expect(instance().preConfig).toHaveLength(1);
    vi.advanceTimersByTime(16 * MIN);
    input();
    expect(instance().preConfig).toHaveLength(0);
  });

  it('a 4 hour session rotates even while active', async () => {
    await start();
    const first = sessionId();
    for (let i = 0; i < 49; i++) {
      vi.advanceTimersByTime(5 * MIN);
      input();
    }
    expect(sessionId()).not.toBe(first);
  });
});
