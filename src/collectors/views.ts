import type { ViewEvent } from '../types';
import type { UrlSanitizer } from '../privacy/url';

/**
 * `sanitizeUrl` is a required argument rather than an internal default so this
 * collector cannot capture a raw `location.href` by omission: every call site
 * has to name the sanitiser it is using.
 */
export function startViewCollector(
  onView: (view: ViewEvent) => void,
  sanitizeUrl: UrlSanitizer,
): void {
  const currentUrl = () => sanitizeUrl(window.location.href);

  // Initial page load
  onView(createViewEvent(currentUrl()));

  // SPA navigation via pushState
  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    originalPushState(...args);
    onView(createViewEvent(currentUrl()));
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (
    ...args: Parameters<typeof history.replaceState>
  ) {
    originalReplaceState(...args);
    onView(createViewEvent(currentUrl()));
  };

  // Back/forward navigation
  window.addEventListener('popstate', () => {
    onView(createViewEvent(currentUrl()));
  });
}

function createViewEvent(url: string): ViewEvent {
  const timing =
    typeof performance !== 'undefined' ? performance.timing : undefined;
  return {
    view_id: crypto.randomUUID(),
    url,
    timestamp: Date.now(),
    load_time_ms: timing
      ? timing.loadEventEnd - timing.navigationStart || undefined
      : undefined,
    dom_ready_ms: timing
      ? timing.domContentLoadedEventEnd - timing.navigationStart || undefined
      : undefined,
  };
}
