import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startResourceCollector,
  createOwnRequestMatcher,
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
});
