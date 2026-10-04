import type { SqEvent } from '../types';
import { ANALYZE, type Hub } from '../hub';
import { epochOf, pct, read, observe } from '../core/util';

/** Allowed `initiatorType` values; anything else is sent as `other`. */
export const RESOURCE_TYPES: readonly string[] =
  'audio beacon body css early-hints embed eventsource fetch frame icon iframe image img input link navigation object other ping script track video xmlhttprequest'.split(' ');

/** Chrome reports the page URL as the type of some favicon entries. */
export function resourceType(initiatorType: unknown): string {
  return typeof initiatorType === 'string' && RESOURCE_TYPES.includes(initiatorType)
    ? initiatorType
    : 'other';
}

const INITIAL_INDIVIDUAL = 150;
const AGGREGATE_MS = 30_000;

export interface ResourcesOptions {
  /** fetch and XHR entries, for the network collector's timing join. */
  onRequestEntry: (e: PerformanceResourceTiming) => void;
}

export type Resources = ReturnType<typeof startResources>;

const ms = (n: number) => (n > 0 ? Math.round(n) : undefined);

/** Duration and the phases resource timing exposes (zero cross-origin without Timing-Allow-Origin). */
export const timing = (e: PerformanceResourceTiming) => ({
  duration_ms: Math.round(e.duration),
  dns_ms: ms(e.domainLookupEnd - e.domainLookupStart),
  connect_ms: ms(e.connectEnd - e.connectStart),
  tls_ms: e.secureConnectionStart > 0 ? ms(e.connectEnd - e.secureConnectionStart) : undefined,
  ttfb_ms: ms(e.responseStart - e.requestStart),
  download_ms: ms(e.responseEnd - e.responseStart),
});

/**
 * Subresources from resource timing (design 5.6): the first 150 of the initial view and the
 * LCP resource one by one, later ones aggregated per view and origin. Own requests and the
 * app's resource exclusions are never recorded.
 */
export function startResources(h: Hub, o: ResourcesOptions) {
  let exclusions: readonly string[] | undefined;
  let isExcluded: UrlMatcher = () => false;
  let individual = 0;
  let initialView = '';
  const sent = new Set<string>();
  const buckets = new Map<string, { e: SqEvent; d: number[] }>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function row(re: PerformanceResourceTiming): SqEvent {
    const status = (re as PerformanceResourceTiming & { responseStatus?: number }).responseStatus;
    return {
      k: 'resource',
      t: epochOf(re.startTime),
      view_id: h.viewId(),
      initiator: resourceType(re.initiatorType),
      url: h.url(re.name),
      ...timing(re),
      transfer_bytes: re.transferSize > 0 ? re.transferSize : undefined,
      decoded_bytes: re.decodedBodySize > 0 ? re.decodedBodySize : undefined,
      render_blocking: (re as PerformanceResourceTiming & { renderBlockingStatus?: string }).renderBlockingStatus === 'blocking' || undefined,
      status: status && status > 0 ? status : undefined,
    };
  }

  function flush(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const { e, d } of buckets.values()) {
      const p50 = Math.round(pct(d, 0.5));
      h.emit({ ...e, duration_ms: p50, n: d.length, p50_ms: p50, p95_ms: Math.round(pct(d, 0.95)) }, ANALYZE);
    }
    buckets.clear();
  }

  function handle(re: PerformanceResourceTiming): void {
    if (re.initiatorType === 'fetch' || re.initiatorType === 'xmlhttprequest') return o.onRequestEntry(re);
    const exc = h.cfg().capture.resource_exclusions;
    if (exc !== exclusions) {
      exclusions = exc;
      isExcluded = createExclusionMatcher(exc);
    }
    const target = parsePrefix(re.name);
    if (target && (h.isOwn(re.name) || isExcluded(target))) return;
    const view = h.viewId();
    if (!initialView) initialView = view;
    if (view === initialView && individual < INITIAL_INDIVIDUAL) {
      individual++;
      sent.add(re.name);
      h.emit(row(re), ANALYZE);
      return;
    }
    const origin = target?.origin ?? 'other';
    const key = `${view} ${re.initiatorType} ${origin}`;
    let b = buckets.get(key);
    if (!b) {
      // Per-request phases and status mean nothing for an aggregate.
      const { dns_ms, connect_ms, tls_ms, ttfb_ms, download_ms, status, ...e } = row(re);
      b = { e: { ...e, url: origin }, d: [] };
      buckets.set(key, b);
      if (!timer) timer = setTimeout(flush, AGGREGATE_MS);
    } else {
      const e = b.e as Record<string, number | undefined>;
      e.transfer_bytes = (e.transfer_bytes ?? 0) + (re.transferSize || 0) || undefined;
      e.decoded_bytes = (e.decoded_bytes ?? 0) + (re.decodedBodySize || 0) || undefined;
    }
    if (b.d.length < 1000) b.d.push(re.duration);
  }

  observe('resource', (list) => {
    // One bad entry must not stop the rest.
    for (const e of list) read(() => handle(e as PerformanceResourceTiming));
  });

  return {
    flush,
    /** The LCP element's resource, always sent alone (design 5.6). */
    lcp(url: string): void {
      if (!url || sent.has(url)) return;
      const e = read(() => performance.getEntriesByName(url, 'resource')[0]) as PerformanceResourceTiming | undefined;
      if (!e) return;
      sent.add(url);
      h.emit(row(e), ANALYZE);
    },
  };
}

export interface UrlPrefix {
  origin: string;
  path: string;
}

/** Takes a URL or one already parsed; a relative URL never matches. */
export type UrlMatcher = (url: string | UrlPrefix) => boolean;

/**
 * True for a URL under one of `bases`: the same origin (scheme, host and port,
 * normalised by the URL parser, so case and default ports do not matter) and a
 * path equal to the base's path or below it at a segment boundary. A base with
 * a path, such as a same-origin proxy at `https://example.com/rum`, matches
 * `/rum` and `/rum/v1/events` but not `/rumble`. A relative base resolves
 * against the page, as `fetch` resolves it. A base that does not parse is
 * ignored.
 */
export function createOwnRequestMatcher(bases: readonly string[]): UrlMatcher {
  const pageUrl = currentPageUrl();
  return prefixMatcher(bases.map((base) => parsePrefix(base, pageUrl)));
}

/**
 * Matches resource URLs against the application's `resource_exclusions`. A rule
 * is a path on the page's origin ("/b") or an absolute origin with optional path.
 */
export function createExclusionMatcher(
  rules: readonly unknown[],
  pageUrl: string | undefined = currentPageUrl(),
): UrlMatcher {
  const pageOrigin = (pageUrl && parsePrefix(pageUrl)?.origin) || null;
  const list = Array.isArray(rules) ? rules : [];
  return prefixMatcher(list.map((rule) => parseExclusionRule(rule, pageOrigin)));
}

// Rust's char::is_whitespace, which differs from \s on U+0085 and U+FEFF.
const UNSUPPORTED_RULE_CHARS =
  /[?#\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** Mirrors Rule::parse in core-rs, so both matchers skip the same rules. */
function parseExclusionRule(
  rule: unknown,
  pageOrigin: string | null,
): UrlPrefix | null {
  if (typeof rule !== 'string' || UNSUPPORTED_RULE_CHARS.test(rule)) return null;
  // A path rule is literal, so "//x" is a path on the page's origin, not a host.
  if (rule.startsWith('/')) {
    return pageOrigin ? parsePrefix(pageOrigin + rule) : null;
  }
  const prefix = parsePrefix(rule);
  return prefix && /^https?:/.test(prefix.origin) ? prefix : null;
}

function prefixMatcher(parsed: readonly (UrlPrefix | null)[]): UrlMatcher {
  const prefixes = parsed.filter((p): p is UrlPrefix => p !== null);
  if (prefixes.length === 0) return () => false;

  return (url) => {
    const target = typeof url === 'string' ? parsePrefix(url) : url;
    return target !== null && prefixes.some((p) => isUnder(target, p));
  };
}

/** Same origin, and the path is the prefix's path or below it at a segment boundary. */
function isUnder(target: UrlPrefix, prefix: UrlPrefix): boolean {
  return (
    target.origin === prefix.origin &&
    (prefix.path === '' ||
      target.path === prefix.path ||
      target.path.startsWith(`${prefix.path}/`))
  );
}

function currentPageUrl(): string | undefined {
  return typeof location !== 'undefined' ? location.href : undefined;
}

export function parsePrefix(url: string, base?: string): UrlPrefix | null {
  try {
    const parsed = new URL(url, base);
    // data:, blob: and the like have an opaque origin, serialised as "null".
    if (parsed.origin === 'null') return null;
    return { origin: parsed.origin, path: trimTrailingSlashes(parsed.pathname) };
  } catch {
    return null;
  }
}

// A loop, since /\/+$/ backtracks quadratically on long runs of slashes.
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}
