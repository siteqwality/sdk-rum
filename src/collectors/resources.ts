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
 */
export function startResourceCollector(
  onResource: (resource: CollectedResource) => void,
  sanitizeUrl: UrlSanitizer,
): void {
  if (typeof PerformanceObserver === 'undefined') return;

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const re = entry as PerformanceResourceTiming;
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
