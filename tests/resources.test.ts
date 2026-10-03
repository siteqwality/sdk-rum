import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startResourceCollector,
  createOwnRequestMatcher,
  createResourceIgnoreMatcher,
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

describe('createResourceIgnoreMatcher', () => {
  it('reads a path as this page\'s origin, at a segment boundary, whatever the query', () => {
    vi.stubGlobal('location', { href: 'https://game.example/place' });
    const isIgnored = createResourceIgnoreMatcher(['/b', '/sirtet/game']);
    expect(isIgnored('https://game.example/b')).toBe(true);
    expect(isIgnored('https://game.example/b?t=17&n=2')).toBe(true);
    expect(isIgnored('https://game.example/b/2')).toBe(true);
    expect(isIgnored('https://game.example/sirtet/game?tick=9')).toBe(true);
    expect(isIgnored('https://game.example/blocks')).toBe(false);
    expect(isIgnored('https://game.example/sirtet')).toBe(false);
    // Another origin's /b is not this site's.
    expect(isIgnored('https://other.example/b')).toBe(false);
  });

  it('matches a full URL rule for another origin', () => {
    const isIgnored = createResourceIgnoreMatcher(['https://us.i.posthog.com']);
    expect(isIgnored('https://us.i.posthog.com/e/?ip=1')).toBe(true);
    expect(isIgnored('https://eu.i.posthog.com/e/')).toBe(false);
  });

  it('tests a RegExp against the whole URL, including the query string', () => {
    const isIgnored = createResourceIgnoreMatcher([/[?&]poll=1(&|$)/, /\/heartbeat$/g]);
    expect(isIgnored('https://api.example/state?poll=1')).toBe(true);
    expect(isIgnored('https://api.example/state?poll=10')).toBe(false);
    // A global flag must not make alternate calls miss.
    expect(isIgnored('https://api.example/heartbeat')).toBe(true);
    expect(isIgnored('https://api.example/heartbeat')).toBe(true);
  });

  it('calls a predicate, and a predicate that throws skips nothing', () => {
    const isIgnored = createResourceIgnoreMatcher([
      (url) => url.endsWith('.png'),
      () => {
        throw new Error('bad rule');
      },
    ]);
    expect(isIgnored('https://cdn.example/a.png')).toBe(true);
    expect(isIgnored('https://cdn.example/app.js')).toBe(false);
  });

  it('ignores nothing when there are no rules', () => {
    expect(createResourceIgnoreMatcher([])('https://game.example/b')).toBe(false);
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

  it('does not record requests matching ignoreResourceUrls', () => {
    vi.stubGlobal('location', { href: 'https://game.example/' });
    const observer = installObserver();
    const seen: CollectedResource[] = [];
    startResourceCollector((r) => seen.push(r), createUrlSanitizer(), DEFAULT_BASES, [
      '/b',
      '/sirtet/game',
    ]);

    observer.emit([
      entry('https://game.example/b?t=1'),
      entry('https://game.example/sirtet/game'),
      entry('https://game.example/blocks'),
      entry('https://rum.siteqwality.com/v1/events'),
    ]);

    expect(seen.map((r) => r.resource_url)).toEqual(['https://game.example/blocks']);
  });
});
