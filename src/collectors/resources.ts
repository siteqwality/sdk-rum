import type { UrlSanitizer } from '../privacy/url';

export interface CollectedResource {
  resource_type: string;
  resource_url: string;
  duration_ms: number;
  transfer_size: number;
}

/**
 * `entry.name` is the absolute URL of every subresource, fetch and XHR the page
 * issues, which is where an API call's query string (and therefore its tokens
 * and identifiers) shows up. It goes through `sanitizeUrl` before it leaves the
 * browser, on the same rules as a page URL.
 *
 * Requests to `ownBases` (the ingest and replay bases) are never recorded.
 * Every send the SDK makes is itself a resource entry, so recording them feeds
 * the SDK its own traffic: each batch produced an event about itself, and on a
 * hidden page, where each enqueue sent at once, that looped at network speed.
 */
export function startResourceCollector(
  onResource: (resource: CollectedResource) => void,
  sanitizeUrl: UrlSanitizer,
  ownBases: readonly string[],
  getExclusions: () => readonly string[] | undefined = () => undefined,
): void {
  if (typeof PerformanceObserver === 'undefined') return;

  const isOwnRequest = createOwnRequestMatcher(ownBases);
  // Recompiled only when a config refresh swaps in a new rule list.
  let exclusions: readonly string[] | undefined;
  let isExcluded: (url: string) => boolean = () => false;

  const observer = new PerformanceObserver((list) => {
    const current = getExclusions();
    if (current !== exclusions) {
      exclusions = current;
      isExcluded = createExclusionMatcher(current ?? []);
    }
    for (const entry of list.getEntries()) {
      const re = entry as PerformanceResourceTiming;
      if (isOwnRequest(re.name) || isExcluded(re.name)) continue;
      onResource({
        resource_type: re.initiatorType,
        resource_url: sanitizeUrl(re.name),
        duration_ms: re.duration,
        transfer_size: re.transferSize,
      });
    }
  });

  try {
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    // PerformanceObserver resource type not supported
  }
}

interface UrlPrefix {
  origin: string;
  path: string;
}

/**
 * True for a URL under one of `bases`: the same origin (scheme, host and port,
 * normalised by the URL parser, so case and default ports do not matter) and a
 * path equal to the base's path or below it at a segment boundary. A base with
 * a path, such as a same-origin proxy at `https://example.com/rum`, matches
 * `/rum` and `/rum/v1/events` but not `/rumble`. A relative base resolves
 * against the page, as `fetch` resolves it. A base that does not parse is
 * ignored.
 */
export function createOwnRequestMatcher(
  bases: readonly string[],
): (url: string) => boolean {
  const prefixes = bases
    .map((base) => parsePrefix(base))
    .filter((p): p is UrlPrefix => p !== null);
  if (prefixes.length === 0) return () => false;

  return (url) => {
    const target = parsePrefix(url);
    return target !== null && prefixes.some((p) => isUnder(target, p));
  };
}

/**
 * Matches resource URLs against the application's `resource_exclusions`. A rule
 * is a path on the page's origin ("/b") or an absolute origin with optional path.
 */
export function createExclusionMatcher(
  rules: readonly unknown[],
  pageUrl: string | undefined = currentPageUrl(),
): (url: string) => boolean {
  const pageOrigin = (pageUrl && parsePrefix(pageUrl)?.origin) || null;
  const prefixes = (Array.isArray(rules) ? rules : [])
    .map((rule) => parseExclusionRule(rule, pageOrigin))
    .filter((p): p is UrlPrefix => p !== null);
  if (prefixes.length === 0) return () => false;

  return (url) => {
    const target = parsePrefix(url, pageUrl);
    return target !== null && prefixes.some((p) => isUnder(target, p));
  };
}

function parseExclusionRule(
  rule: unknown,
  pageOrigin: string | null,
): UrlPrefix | null {
  if (typeof rule !== 'string') return null;
  const trimmed = rule.trim();
  // A path rule is literal, so "//x" is a path on the page's origin, not a host.
  if (trimmed.startsWith('/')) {
    return pageOrigin ? parsePrefix(pageOrigin + trimmed) : null;
  }
  if (/^https?:\/\//i.test(trimmed)) return parsePrefix(trimmed);
  return null;
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

function parsePrefix(
  url: string,
  base: string | undefined = currentPageUrl(),
): UrlPrefix | null {
  try {
    const parsed = new URL(url, base);
    // data:, blob: and the like have an opaque origin, serialised as "null".
    if (parsed.origin === 'null') return null;
    return { origin: parsed.origin, path: parsed.pathname.replace(/\/+$/, '') };
  } catch {
    return null;
  }
}
