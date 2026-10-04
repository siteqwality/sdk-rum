import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { startResources, createOwnRequestMatcher, createExclusionMatcher, resourceType, RESOURCE_TYPES } from '../src/collectors/resources';
import type { Hub } from '../src/hub';
import type { SqEvent } from '../src/types';
import { FakePerformanceObserver } from './setup';
import { createUrlSanitizer } from '../src/core/url';

const DEFAULT_BASES = ['https://rum.siteqwality.com', 'https://replay.siteqwality.com'];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOwnRequestMatcher', () => {
  it('matches everything under the default ingest and replay bases', () => {
    const isOwn = createOwnRequestMatcher(DEFAULT_BASES);
    expect(isOwn('https://rum.siteqwality.com/v1/events')).toBe(true);
    expect(isOwn('https://rum.siteqwality.com/v1/measure')).toBe(true);
    expect(isOwn('https://rum.siteqwality.com/v1/config')).toBe(true);
    expect(
      isOwn('https://replay.siteqwality.com/v1/segments?session_id=s&segment_index=3'),
    ).toBe(true);
  });

  it('normalises the origin: host case and default port', () => {
    const isOwn = createOwnRequestMatcher(DEFAULT_BASES);
    expect(isOwn('https://RUM.SiteQwality.com:443/v1/events')).toBe(true);
  });

  it('does not match another scheme, host or port', () => {
    const isOwn = createOwnRequestMatcher(DEFAULT_BASES);
    expect(isOwn('http://rum.siteqwality.com/v1/events')).toBe(false);
    expect(isOwn('https://rum.siteqwality.com:8443/v1/events')).toBe(false);
    expect(isOwn('https://siteqwality.com/v1/events')).toBe(false);
    expect(isOwn('https://rum.siteqwality.com.evil.example/v1/events')).toBe(false);
    expect(isOwn('https://api.example.com/v1/events')).toBe(false);
  });

  it('matches a custom base with a path at a segment boundary only', () => {
    const isOwn = createOwnRequestMatcher(['https://example.com/rum']);
    expect(isOwn('https://example.com/rum')).toBe(true);
    expect(isOwn('https://example.com/rum/v1/events')).toBe(true);
    expect(isOwn('https://example.com/rumble')).toBe(false);
    expect(isOwn('https://example.com/api/orders')).toBe(false);
  });

  it('ignores a trailing slash on the base', () => {
    const isOwn = createOwnRequestMatcher(['https://example.com/rum/']);
    // init.ts builds `${ingestBase}/v1/events`, so this is the URL actually sent.
    expect(isOwn('https://example.com/rum//v1/events')).toBe(true);
    expect(isOwn('https://example.com/rum/v1/events')).toBe(true);
  });

  it('resolves a relative base against the page, as fetch does', () => {
    const isOwn = createOwnRequestMatcher(['/rum-proxy']);
    expect(isOwn(`${location.origin}/rum-proxy/v1/events`)).toBe(true);
    expect(isOwn(`${location.origin}/other`)).toBe(false);
  });

  it('ignores a base that does not parse, and never matches opaque URLs', () => {
    const isOwn = createOwnRequestMatcher(['http://', 'data:text/plain,x']);
    expect(isOwn('data:text/plain,x')).toBe(false);
    expect(isOwn('https://api.example.com/v1/events')).toBe(false);
  });
});

// Shared with the ingestor's Rust matcher; keep both in sync.
const PAGE = 'https://game.example/place';
const VECTORS: [rule: string, url: string, match: boolean][] = [
  ['/b', 'https://game.example/b', true],
  ['/b', 'https://game.example/b?t=1', true],
  ['/b', 'https://game.example/b/2', true],
  ['/b', 'https://game.example/blocks', false],
  ['/b', 'https://other.example/b', false],
  ['/b/', 'https://game.example/b', true],
  ['/', 'https://game.example/anything', true],
  ['https://us.i.posthog.com', 'https://us.i.posthog.com/e/?ip=1', true],
  ['https://us.i.posthog.com', 'https://eu.i.posthog.com/e/', false],
  ['https://API.example:443/v1', 'https://api.example/v1/x', true],
  ['https://api.example/v1', 'http://api.example/v1/x', false],
  ['https://api.example/v1', 'https://api.example/v10', false],
];

describe('createExclusionMatcher', () => {
  it.each(VECTORS)('%s vs %s -> %s', (rule, url, match) => {
    expect(createExclusionMatcher([rule], PAGE)(url)).toBe(match);
  });

  it('ignores the fragment', () => {
    expect(createExclusionMatcher(['/b'], PAGE)('https://game.example/b#x')).toBe(true);
  });

  it('matches if any rule matches', () => {
    const isExcluded = createExclusionMatcher(['/a', 'https://us.i.posthog.com'], PAGE);
    expect(isExcluded('https://game.example/a/1')).toBe(true);
    expect(isExcluded('https://us.i.posthog.com/e/')).toBe(true);
    expect(isExcluded('https://game.example/b')).toBe(false);
  });

  it('treats a leading // as a path on the page origin, not a host', () => {
    const isExcluded = createExclusionMatcher(['//other.example'], PAGE);
    expect(isExcluded('https://other.example/x')).toBe(false);
    expect(isExcluded('https://game.example//other.example/x')).toBe(true);
  });

  it('never matches with unsupported or unparseable rules', () => {
    const isExcluded = createExclusionMatcher(
      [
        '', 'b', 'us.i.posthog.com', 'ftp://game.example', 'https://', 42, null,
        '/b?x', '/b#x', '/b c', ' /b ', '/b\u0085',
      ],
      PAGE,
    );
    expect(isExcluded('https://game.example/b')).toBe(false);
    expect(isExcluded('https://game.example/b%20c')).toBe(false);
    expect(isExcluded('https://us.i.posthog.com/e/')).toBe(false);
  });

  it('accepts U+FEFF in a rule, as the ingestor does', () => {
    const isExcluded = createExclusionMatcher(['/a\ufeffb'], PAGE);
    expect(isExcluded('https://game.example/a%EF%BB%BFb')).toBe(true);
  });

  it('never matches an unparseable, opaque or relative resource URL', () => {
    const isExcluded = createExclusionMatcher(['/'], PAGE);
    expect(isExcluded('http://')).toBe(false);
    expect(isExcluded('data:text/plain,x')).toBe(false);
    expect(isExcluded('/b')).toBe(false);
    expect(isExcluded('//game.example/b')).toBe(false);
  });

  it('handles a long run of slashes in linear time', () => {
    const url = `https://game.example/b${'/'.repeat(200_000)}x`;
    expect(createExclusionMatcher(['/b'], PAGE)(url)).toBe(true);
  });

  it('never matches a path rule when the page origin is opaque', () => {
    const isExcluded = createExclusionMatcher(['/'], 'about:blank');
    expect(isExcluded('https://game.example/b')).toBe(false);
  });

  it('treats a missing or malformed rule list as no rules', () => {
    expect(createExclusionMatcher([], PAGE)('https://game.example/b')).toBe(false);
    expect(
      createExclusionMatcher('/b' as unknown as string[], PAGE)('https://game.example/b'),
    ).toBe(false);
  });

  it('defaults the page to location.href', () => {
    expect(createExclusionMatcher(['/b'])(`${location.origin}/b/1`)).toBe(true);
  });
});

describe('startResources', () => {
  let events: SqEvent[];
  let requests: PerformanceEntry[];
  let exclusions: string[];
  let view = 'v1';

  function start() {
    events = [];
    requests = [];
    const url = createUrlSanitizer();
    const own = createOwnRequestMatcher(['https://in.test', 'https://rp.test']);
    const hub = {
      opts: { applicationId: 'a', clientToken: 't' },
      cfg: () => ({ capture: { resource_exclusions: exclusions } }),
      url,
      text: (s: string) => s,
      scrub: (s: string) => s,
      emit: (e: SqEvent) => (events.push(e), true),
      input: () => {},
      crumb: () => {},
      count: () => {},
      isOwn: own,
      pageUrl: () => '',
      viewId: () => view,
      fetch,
    } as unknown as Hub;
    return startResources(hub, { onRequestEntry: (e) => requests.push(e) });
  }

  const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    initiatorType: 'img',
    startTime: 10,
    duration: 42,
    transferSize: 300,
    decodedBodySize: 900,
    encodedBodySize: 300,
    domainLookupStart: 0,
    domainLookupEnd: 0,
    connectStart: 0,
    connectEnd: 0,
    secureConnectionStart: 0,
    requestStart: 12,
    responseStart: 30,
    responseEnd: 52,
    ...extra,
  });

  beforeEach(() => {
    exclusions = [];
    view = 'v1';
  });

  it('sends each resource of the initial view with minimised URL, timing and sizes', () => {
    start();
    FakePerformanceObserver.emit('resource', [entry(`${location.origin}/img/a.png?sig=x`, { renderBlockingStatus: 'blocking', responseStatus: 200 })]);
    expect(events[0]).toMatchObject({
      k: 'resource',
      view_id: 'v1',
      initiator: 'img',
      url: `${location.origin}/img/a.png`,
      duration_ms: 42,
      ttfb_ms: 18,
      download_ms: 22,
      transfer_bytes: 300,
      decoded_bytes: 900,
      render_blocking: true,
      status: 200,
    });
  });

  it('hands fetch and XHR entries to the network collector', () => {
    start();
    FakePerformanceObserver.emit('resource', [entry('https://api.test/x', { initiatorType: 'fetch' }), entry('https://api.test/y', { initiatorType: 'xmlhttprequest' })]);
    expect(events).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('never records its own requests or excluded resources', () => {
    exclusions = ['/b'];
    start();
    FakePerformanceObserver.emit('resource', [entry('https://in.test/v2/batch', { initiatorType: 'beacon' }), entry(`${location.origin}/b?t=1`), entry(`${location.origin}/c`)]);
    expect(events.map((e) => e.url)).toEqual([`${location.origin}/c`]);
  });

  it('aggregates past the first 150 and in later views, per origin, with percentiles', () => {
    const r = start();
    FakePerformanceObserver.emit('resource', Array.from({ length: 152 }, (_, i) => entry(`${location.origin}/i/${i}.png`, { duration: i })));
    expect(events).toHaveLength(150);
    view = 'v2';
    FakePerformanceObserver.emit('resource', [entry('https://cdn.test/a.js', { initiatorType: 'script', duration: 10 }), entry('https://cdn.test/b.js', { initiatorType: 'script', duration: 30 })]);
    r.flush();
    const agg = events.slice(150);
    expect(agg).toHaveLength(2);
    expect(agg[0]).toMatchObject({ view_id: 'v1', url: location.origin, n: 2 });
    expect(agg[1]).toMatchObject({ view_id: 'v2', initiator: 'script', url: 'https://cdn.test', n: 2, p50_ms: 30, p95_ms: 30 });
  });

  it('sends the LCP resource on its own', () => {
    const r = start();
    FakePerformanceObserver.emit('resource', Array.from({ length: 151 }, (_, i) => entry(`${location.origin}/i/${i}.png`)));
    vi.spyOn(performance, 'getEntriesByName').mockReturnValue([entry(`${location.origin}/hero.jpg`) as unknown as PerformanceEntry]);
    r.lcp(`${location.origin}/hero.jpg`);
    expect(events.at(-1)).toMatchObject({ url: `${location.origin}/hero.jpg`, initiator: 'img' });
  });
});

describe('resource types', () => {
  it('passes every allowed initiatorType through', () => {
    for (const type of RESOURCE_TYPES) expect(resourceType(type)).toBe(type);
    expect(RESOURCE_TYPES).toHaveLength(23);
  });

  it('maps anything else to other, a page URL included', () => {
    for (const value of [
      'https://shop.example.com/profiles/jane?f=secret',
      'FETCH',
      '',
      'font',
      undefined,
      null,
      42,
    ]) {
      expect(resourceType(value)).toBe('other');
    }
  });

});
