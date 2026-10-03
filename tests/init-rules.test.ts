import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import { startVitalsCollector } from '../src/collectors/vitals';
import { startResourceCollector } from '../src/collectors/resources';
import {
  click,
  configResponse,
  details,
  el,
  holdConfig,
  init,
  instance,
  newPageLoad,
  resetSdk,
  serveConfig,
  settle,
  ERROR_RULE,
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
vi.mock('../src/replay/recorder', () => ({
  ReplayRecorder: class {
    start = vi.fn(async () => {});
    stop = vi.fn();
  },
}));

const registry = h.transports as Registry;
const recorder = () => instance().replayRecorder as { start: ReturnType<typeof vi.fn> };
const sessionId = () => instance().session.current() as string;
const stored = () => JSON.parse(sessionStorage.getItem(`sq_rum_rules:${sessionId()}`) ?? 'null');

beforeEach(() => {
  vi.useFakeTimers();
  resetSdk();
  h.transports.length = 0;
  vi.mocked(startVitalsCollector).mockClear();
  vi.mocked(startResourceCollector).mockClear();
  document.body.innerHTML = '';
  history.replaceState({}, '', '/');
});

afterEach(() => {
  resetSdk();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(filters: object[]) {
  serveConfig(filters);
  await init();
  await settle();
}

function clicks(n: number) {
  const button = el('<button>b</button>');
  for (let i = 0; i < n; i++) {
    click(button);
    vi.advanceTimersByTime(1_100);
  }
}

describe('when rules are evaluated', () => {
  it('a match-all replay rule starts replay as the config arrives, with no timer', async () => {
    const release = holdConfig([MATCH_ALL_REPLAY]);
    void init();
    expect(recorder().start).not.toHaveBeenCalled();
    release();
    await settle();
    expect(recorder().start).toHaveBeenCalledTimes(1);
    expect(recorder().start.mock.calls[0][0]).toBe(sessionId());
  });

  it('a sent error is evaluated at once; an ignored one never is', async () => {
    serveConfig([ERROR_RULE]);
    await init({ ignoreErrors: ['benign'] });
    await settle();
    SiteQwalityRUM.addError(new Error('benign thing'));
    expect(instance().detailActive).toBe(false);
    SiteQwalityRUM.addError(new Error('real'));
    expect(instance().detailActive).toBe(true);
    expect(recorder().start).toHaveBeenCalledTimes(1);
  });

  it('after a vital', async () => {
    await start([{ filter_type: 'slow_performance', conditions: { lcp_gt_ms: 4000 }, capture_replay: false }]);
    vi.mocked(startVitalsCollector).mock.calls.at(-1)![0]('lcp_ms', 3000);
    expect(instance().detailActive).toBe(false);
    vi.mocked(startVitalsCollector).mock.calls.at(-1)![0]('lcp_ms', 5200);
    expect(instance().detailActive).toBe(true);
  });

  it('after an action', async () => {
    await start([{ filter_type: 'custom', conditions: { min_actions: 2 }, capture_replay: false }]);
    SiteQwalityRUM.addAction('one');
    expect(instance().detailActive).toBe(false);
    SiteQwalityRUM.addAction('two');
    expect(instance().detailActive).toBe(true);
  });

  it('after setUser', async () => {
    await start([{ filter_type: 'custom', conditions: { has_user: true }, capture_replay: true }]);
    expect(instance().detailActive).toBe(false);
    SiteQwalityRUM.setUser({ id: 'u1' });
    expect(instance().detailActive).toBe(true);
    expect(recorder().start).toHaveBeenCalledTimes(1);
  });

  it('after a config refresh adds a rule', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(configResponse([]))
      .mockResolvedValue(configResponse([MATCH_ALL]));
    vi.stubGlobal('fetch', fetchMock);
    await init();
    await settle();
    expect(instance().detailActive).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(instance().detailActive).toBe(true);
  });

  it('a custom rule with a key the SDK cannot check never matches', async () => {
    await start([{ filter_type: 'custom', conditions: { url: '/checkout' }, capture_replay: true }]);
    SiteQwalityRUM.setUser({ id: 'u1' });
    SiteQwalityRUM.addAction('a');
    expect(instance().detailActive).toBe(false);
    expect(recorder().start).not.toHaveBeenCalled();
  });
});

describe('the decision persists per session and tab', () => {
  it('is stored as {"v":1,"detail","replay","actions"}', async () => {
    await start([ERROR_RULE]);
    SiteQwalityRUM.addAction('a');
    expect(stored()).toEqual({ v: 1, detail: false, replay: false, actions: 1 });
    SiteQwalityRUM.addError(new Error('boom'));
    expect(stored()).toEqual({ v: 1, detail: true, replay: true, actions: 1 });
  });

  it('a reload resumes detail at once and replay once the config arrives', async () => {
    await start([ERROR_RULE]);
    SiteQwalityRUM.addError(new Error('boom'));
    const sid = sessionId();

    newPageLoad();
    const release = holdConfig([ERROR_RULE]);
    void init();
    expect(sessionId()).toBe(sid);
    expect(instance().detailActive).toBe(true);
    expect(recorder().start).not.toHaveBeenCalled();
    release();
    await settle();
    expect(recorder().start).toHaveBeenCalledTimes(1);
    expect(instance().sessionState.hasError).toBe(false);
  });

  it('a resumed detail decision sends the pre-config buffer even if config fails', async () => {
    await start([MATCH_ALL]);
    newPageLoad();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    void init();
    vi.mocked(startResourceCollector).mock.calls.at(-1)![0]({
      resource_type: 'script', resource_url: 'https://a.example/app.js', duration_ms: 9, transfer_size: 10,
    });
    await settle();
    expect(details(registry).map((e) => e.resource_url)).toEqual(['https://a.example/app.js']);
  });

  it('replay does not resume once no rule records replay', async () => {
    await start([MATCH_ALL_REPLAY]);
    newPageLoad();
    await start([MATCH_ALL]);
    expect(recorder().start).not.toHaveBeenCalled();
    expect(stored().replay).toBe(true);
  });

  it('a 1.0.7 session that recorded resumes detail and replay', async () => {
    const sid = '11111111-1111-4111-8111-111111111111';
    const now = Date.now();
    sessionStorage.setItem('sq_rum_session', JSON.stringify({ id: sid, started: now, lastActivity: now }));
    sessionStorage.setItem(`sq_rum_replay_next:${sid}`, '3');
    const release = holdConfig([ERROR_RULE]);
    void init();
    expect(instance().detailActive).toBe(true);
    release();
    await settle();
    expect(recorder().start).toHaveBeenCalledWith(sid, expect.any(Function), expect.any(Object), expect.any(Function), undefined);
  });

  it('min_actions: 5 matches on the second page after 3 clicks on each', async () => {
    await start([{ filter_type: 'custom', conditions: { min_actions: 5 }, capture_replay: false }]);
    clicks(3);
    expect(instance().detailActive).toBe(false);

    newPageLoad();
    await start([{ filter_type: 'custom', conditions: { min_actions: 5 }, capture_replay: false }]);
    expect(instance().sessionState.actionCount).toBe(3);
    clicks(1);
    expect(instance().detailActive).toBe(false);
    clicks(1);
    expect(instance().detailActive).toBe(true);
  });

  it('a corrupt stored decision is ignored', async () => {
    await start([]);
    const sid = sessionId();
    newPageLoad();
    sessionStorage.setItem(`sq_rum_rules:${sid}`, '{not json');
    await start([]);
    expect(instance().detailActive).toBe(false);
    sessionStorage.setItem(`sq_rum_rules:${sid}`, JSON.stringify({ v: 2, detail: true }));
    newPageLoad();
    await start([]);
    expect(instance().detailActive).toBe(false);
  });
});
