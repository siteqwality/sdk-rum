import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startResourceCollector,
  createOwnRequestMatcher,
  createExclusionMatcher,
  type CollectedResource,
} from '../src/collectors/resources';
import { createUrlSanitizer } from '../src/privacy/url';

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
      ['', 'b', 'us.i.posthog.com', 'ftp://game.example', 'https://', 42, null],
      PAGE,
    );
    expect(isExcluded('https://game.example/b')).toBe(false);
    expect(isExcluded('https://us.i.posthog.com/e/')).toBe(false);
  });

  it('never matches an unparseable or opaque resource URL', () => {
    const isExcluded = createExclusionMatcher(['/'], PAGE);
    expect(isExcluded('http://')).toBe(false);
    expect(isExcluded('data:text/plain,x')).toBe(false);
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

describe('startResourceCollector', () => {
  type Callback = (list: { getEntries: () => unknown[] }) => void;

  function installObserver(): { emit: (entries: object[]) => void } {
    let callback: Callback | null = null;
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        constructor(cb: Callback) {
          callback = cb;
        }
        observe(): void {}
      },
    );
    return {
      emit: (entries) => callback!({ getEntries: () => entries }),
    };
  }

  function entry(name: string, initiatorType = 'fetch') {
    return { name, initiatorType, duration: 12, transferSize: 300 };
  }

  it('never records requests to the ingest or replay base', () => {
    const observer = installObserver();
    const seen: CollectedResource[] = [];
    startResourceCollector((r) => seen.push(r), createUrlSanitizer(), DEFAULT_BASES);

    observer.emit([
      entry('https://rum.siteqwality.com/v1/events'),
      entry('https://rum.siteqwality.com/v1/measure'),
      entry('https://rum.siteqwality.com/v1/config'),
      entry('https://replay.siteqwality.com/v1/segments?session_id=s&segment_index=0'),
      entry('https://api.example.com/orders?id=7'),
      entry('https://cdn.example.com/app.js', 'script'),
    ]);

    expect(seen.map((r) => r.resource_url)).toEqual([
      'https://api.example.com/orders',
      'https://cdn.example.com/app.js',
    ]);
  });

  it('never records requests to a custom ingest base', () => {
    const observer = installObserver();
    const seen: CollectedResource[] = [];
    startResourceCollector((r) => seen.push(r), createUrlSanitizer(), [
      'https://telemetry.customer.example/rum',
      'https://replay.siteqwality.com',
    ]);

    observer.emit([
      entry('https://telemetry.customer.example/rum/v1/events'),
      entry('https://telemetry.customer.example/api/cart'),
      // The default base is not ours once a custom one is configured.
      entry('https://rum.siteqwality.com/v1/events'),
    ]);

    expect(seen.map((r) => r.resource_url)).toEqual([
      'https://telemetry.customer.example/api/cart',
      'https://rum.siteqwality.com/v1/events',
    ]);
  });

  it('skips resources matching the remote exclusions', () => {
    const observer = installObserver();
    const seen: CollectedResource[] = [];
    startResourceCollector(
      (r) => seen.push(r),
      createUrlSanitizer(),
      DEFAULT_BASES,
      () => ['/b', 'https://us.i.posthog.com'],
    );

    observer.emit([
      entry(`${location.origin}/b?t=1`),
      entry(`${location.origin}/blocks`),
      entry('https://us.i.posthog.com/e/?ip=1'),
      entry('https://rum.siteqwality.com/v1/events'),
      entry('https://api.example.com/orders'),
    ]);

    expect(seen.map((r) => r.resource_url)).toEqual([
      `${location.origin}/blocks`,
      'https://api.example.com/orders',
    ]);
  });

  it('applies a new rule list on the next batch', () => {
    const observer = installObserver();
    const seen: CollectedResource[] = [];
    let rules: string[] | undefined;
    startResourceCollector(
      (r) => seen.push(r),
      createUrlSanitizer(),
      DEFAULT_BASES,
      () => rules,
    );

    observer.emit([entry(`${location.origin}/b`)]);
    rules = ['/b'];
    observer.emit([entry(`${location.origin}/b`), entry(`${location.origin}/c`)]);
    rules = ['/c'];
    observer.emit([entry(`${location.origin}/b`), entry(`${location.origin}/c`)]);
    rules = undefined;
    observer.emit([entry(`${location.origin}/c`)]);

    expect(seen.map((r) => new URL(r.resource_url).pathname)).toEqual([
      '/b',
      '/c',
      '/b',
      '/c',
    ]);
  });
});
