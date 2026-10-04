import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startVitals, selector } from '../src/collectors/vitals';
import { startFrames, recentFrames } from '../src/collectors/frames';
import { createUrlSanitizer, createTextUrlSanitizer } from '../src/core/url';
import type { Hub } from '../src/hub';
import type { SqEvent } from '../src/types';
import { FakePerformanceObserver } from './setup';

const emit = FakePerformanceObserver.emit;
let reports: Array<{ fields: Record<string, unknown>; metric: string; value: number }>;
let events: SqEvent[];

function hub(): Hub {
  const url = createUrlSanitizer();
  return {
    opts: { applicationId: 'a', clientToken: 't' },
    cfg: () => ({}) as never,
    url,
    text: createTextUrlSanitizer(url),
    scrub: (s) => s,
    emit: (e) => (events.push(e), true),
    input: () => {},
    crumb: () => {},
    count: () => {},
    isOwn: () => false,
    pageUrl: () => '',
    viewId: () => 'v',
  };
}

function hide() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
}

beforeEach(() => {
  reports = [];
  events = [];
  recentFrames.length = 0;
  document.body.innerHTML = '<main id="app"><img class="hero b a" src="/h.png"><button class="buy">Buy</button></main>';
  startVitals(hub(), (fields, metric, value) => reports.push({ fields, metric, value }));
});

describe('selector', () => {
  it('matches web-vitals: #id, else tag and sorted classes, joined by >', () => {
    expect(selector(document.querySelector('img'))).toBe('#app>img.a.b.hero');
    expect(selector(null)).toBeUndefined();
  });
});

describe('vitals', () => {
  it('FCP once, before the page was hidden', () => {
    emit('paint', [{ name: 'first-paint', startTime: 50 }, { name: 'first-contentful-paint', startTime: 120.4 }]);
    expect(reports).toEqual([{ fields: { fcp_ms: 120 }, metric: 'fcp', value: 120.4 }]);
  });

  it('LCP is final at the first trusted input or hide, with sub-parts', () => {
    const img = document.querySelector('img')!;
    emit('largest-contentful-paint', [{ startTime: 900, element: img, url: 'https://x.test/h.png?sig=1' }]);
    expect(reports).toEqual([]);
    hide();
    const lcp = reports.find((r) => r.metric === 'lcp')!;
    expect(lcp.value).toBe(900);
    expect(lcp.fields).toMatchObject({ lcp_ms: 900, lcp: { target: '#app>img.a.b.hero', resource_url: 'https://x.test/h.png', render_delay_ms: 900 } });
    hide();
    expect(reports.filter((r) => r.metric === 'lcp')).toHaveLength(1);
  });

  it('CLS is the largest session window, reported on hide when it changed', () => {
    const node = document.querySelector('button')!;
    emit('layout-shift', [
      { startTime: 100, value: 0.05, hadRecentInput: false, sources: [{ node }] },
      { startTime: 600, value: 0.1, hadRecentInput: false, sources: [{ node }] },
      { startTime: 700, value: 0.5, hadRecentInput: true },
      { startTime: 9000, value: 0.12, hadRecentInput: false },
    ]);
    hide();
    hide();
    const cls = reports.filter((r) => r.metric === 'cls');
    expect(cls).toHaveLength(1);
    expect(cls[0].fields).toEqual({ cls: 0.15, cls_target: '#app>button.buy' });
  });

  it('INP: the worst interaction (fewer than 50) with phases and the longest LoAF script', () => {
    vi.stubGlobal('PerformanceEventTiming', class { get interactionId() { return 0; } });
    document.body.innerHTML = '<button class="buy">Buy</button>';
    reports = [];
    startVitals(hub(), (fields, metric, value) => reports.push({ fields, metric, value }));
    startFrames(hub());
    const target = document.querySelector('button')!;
    emit('long-animation-frame', [
      { startTime: 990, duration: 200, blockingDuration: 150, scripts: [{ sourceURL: 'https://x.test/app.js?v=1', startTime: 1000, duration: 120, sourceFunctionName: 'onBuy' }] },
    ]);
    emit('event', [
      { name: 'pointerdown', interactionId: 7, startTime: 1000, duration: 64, processingStart: 1010, processingEnd: 1020, target },
      { name: 'click', interactionId: 7, startTime: 1001, duration: 248, processingStart: 1020, processingEnd: 1200, target },
      { name: 'keydown', interactionId: 9, startTime: 5000, duration: 48, processingStart: 5004, processingEnd: 5030, target },
    ]);
    hide();
    const inp = reports.find((r) => r.metric === 'inp')!;
    expect(inp.value).toBe(248);
    expect(inp.fields).toEqual({
      inp_ms: 248,
      inp: { target: 'html>body>button.buy', event_type: 'click', input_delay_ms: 19, processing_ms: 180, presentation_ms: 49, script_url: 'https://x.test/app.js' },
    });
    vi.unstubAllGlobals();
  });
});

describe('long frames', () => {
  it('sends LoAF with the 5 longest scripts, minimised', () => {
    startFrames(hub());
    emit('long-animation-frame', [
      {
        startTime: 10,
        duration: 120,
        blockingDuration: 70,
        styleAndLayoutStart: 110,
        scripts: Array.from({ length: 7 }, (_, i) => ({ sourceURL: `https://x.test/s${i}.js?t=1`, sourceFunctionName: `f${i}`, invoker: 'BUTTON.onclick', invokerType: 'event-listener', startTime: 10, duration: i * 10 })),
      },
    ]);
    const [e] = events;
    expect(e).toMatchObject({ k: 'long_frame', duration_ms: 120, blocking_ms: 70, style_layout_ms: 20 });
    const scripts = e.scripts as Array<{ url: string; duration_ms: number }>;
    expect(scripts.map((s) => s.duration_ms)).toEqual([60, 50, 40, 30, 20]);
    expect(scripts[0].url).toBe('https://x.test/s6.js');
  });
});
