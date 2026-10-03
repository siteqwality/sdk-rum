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
  let isExcluded: UrlMatcher = () => false;

  const observer = new PerformanceObserver((list) => {
    const current = getExclusions();
    if (current !== exclusions) {
      exclusions = current;
      isExcluded = createExclusionMatcher(current ?? []);
    }
    for (const entry of list.getEntries()) {
      const re = entry as PerformanceResourceTiming;
      const target = parsePrefix(re.name);
      if (target && (isOwnRequest(target) || isExcluded(target))) continue;
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

function parsePrefix(url: string, base?: string): UrlPrefix | null {
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
