import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startViewCollector, readLoadTimings } from '../src/collectors/views';
import { createUrlSanitizer } from '../src/privacy/url';
import type { ViewEvent } from '../src/types';

const sanitize = createUrlSanitizer();

function navigationEntry(loadEventEnd: number, domContentLoadedEventEnd: number) {
  const entry = { loadEventEnd, domContentLoadedEventEnd };
  vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) =>
    type === 'navigation' ? ([entry] as unknown as PerformanceEntryList) : [],
  );
  return entry;
}

function setReadyState(state: DocumentReadyState) {
  Object.defineProperty(document, 'readyState', { value: state, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState({}, '', '/start');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setReadyState('complete');
});

function collect(options: Parameters<typeof startViewCollector>[2] = {}) {
  const views: ViewEvent[] = [];
  const collector = startViewCollector((v) => views.push(v), sanitize, options);
  return { views, collector };
}

describe('initial view', () => {
  it('carries Navigation Timing load times when the load has ended', () => {
    navigationEntry(1234.6, 800.2);
    const { views } = collect();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      loading_type: 'initial_load',
      url: 'http://localhost:3000/start',
      load_time_ms: 1235,
      dom_ready_ms: 800,
    });
  });

  it('goes out without timings before the load ends, then reports them once after load', () => {
    const entry = navigationEntry(0, 0);
    setReadyState('loading');
    const onLoadTimings = vi.fn();
    const { views } = collect({ onLoadTimings });
    expect(views[0]).not.toHaveProperty('load_time_ms');
    expect(views[0]).not.toHaveProperty('dom_ready_ms');

    entry.domContentLoadedEventEnd = 400;
    window.dispatchEvent(new Event('load'));
    expect(onLoadTimings).not.toHaveBeenCalled();
    entry.loadEventEnd = 950;
    vi.advanceTimersByTime(0);
    expect(onLoadTimings).toHaveBeenCalledTimes(1);
    expect(onLoadTimings).toHaveBeenCalledWith({ load_time_ms: 950, dom_ready_ms: 400 });

    window.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(0);
    expect(onLoadTimings).toHaveBeenCalledTimes(1);
  });

  it('inside a load handler (complete, loadEventEnd 0) reads one macrotask later', () => {
    const entry = navigationEntry(0, 300);
    setReadyState('complete');
    const onLoadTimings = vi.fn();
    collect({ onLoadTimings });
    entry.loadEventEnd = 700;
    vi.advanceTimersByTime(0);
    expect(onLoadTimings).toHaveBeenCalledWith({ load_time_ms: 700, dom_ready_ms: 300 });
  });

  it('never reports a zero or negative time', () => {
    navigationEntry(0, 0);
    expect(readLoadTimings()).toBeNull();
    navigationEntry(500, -3);
    expect(readLoadTimings()).toEqual({ load_time_ms: 500 });
  });

  it('sends no timings where Navigation Timing is missing', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    const onLoadTimings = vi.fn();
    const { views } = collect({ onLoadTimings });
    vi.advanceTimersByTime(10);
    expect(views[0]).not.toHaveProperty('load_time_ms');
    expect(onLoadTimings).not.toHaveBeenCalled();
  });
});

describe('route changes', () => {
  beforeEach(() => navigationEntry(1000, 500));

  it('replaceState with the same URL emits nothing', () => {
    const { views } = collect();
    history.replaceState({ hydrated: true }, '', '/start');
    expect(views).toHaveLength(1);
  });

  it('a query-only or hash-only change emits nothing, as both are stripped', () => {
    const { views } = collect();
    history.replaceState({}, '', '/start?tab=2');
    history.pushState({}, '', '/start?tab=3#section');
    expect(views).toHaveLength(1);
  });

  it('pushState to a new path is a route change with no timings', () => {
    const { views } = collect();
    history.pushState({}, '', '/products/42');
    expect(views).toHaveLength(2);
    expect(views[1]).toMatchObject({ loading_type: 'route_change', url: 'http://localhost:3000/products/42' });
    expect(views[1]).not.toHaveProperty('load_time_ms');
    expect(views[1]).not.toHaveProperty('dom_ready_ms');
    expect(views[1].view_id).not.toBe(views[0].view_id);
  });

  it('popstate starts a view only when the URL changed', () => {
    const { views } = collect();
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(views).toHaveLength(1);
    history.replaceState({}, '', '/back');
    // replaceState itself starts that view; a later popstate to the same URL adds none.
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(views.map((v) => v.url)).toEqual(['http://localhost:3000/start', 'http://localhost:3000/back']);
  });

  it('reports every history call, changed or not', () => {
    const onHistoryChange = vi.fn();
    collect({ onHistoryChange });
    history.replaceState({}, '', '/start');
    history.pushState({}, '', '/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(onHistoryChange).toHaveBeenCalledTimes(3);
  });

  it('restart starts a new view for the current URL', () => {
    const { views, collector } = collect();
    collector.restart();
    expect(views).toHaveLength(2);
    expect(views[1]).toMatchObject({ loading_type: 'route_change', url: 'http://localhost:3000/start' });
  });

  it('keeps the host navigation call intact, failures included', () => {
    collect();
    expect(history.pushState({}, '', '/ok')).toBeUndefined();
    expect(() => history.pushState({}, '', 'https://elsewhere.example/')).toThrow();
  });

  it('never throws into the host navigation call', () => {
    startViewCollector(
      (v) => {
        if (v.loading_type === 'route_change') throw new Error('handler bug');
      },
      sanitize,
    );
    expect(() => history.pushState({}, '', '/still-fine')).not.toThrow();
  });
});
