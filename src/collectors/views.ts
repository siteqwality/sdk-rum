import type { ViewEvent } from '../types';

export function startViewCollector(
  onView: (view: ViewEvent) => void,
): void {
  // Initial page load
  onView(createViewEvent(window.location.href));

  // SPA navigation via pushState
  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    originalPushState(...args);
    onView(createViewEvent(window.location.href));
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (
    ...args: Parameters<typeof history.replaceState>
  ) {
    originalReplaceState(...args);
    onView(createViewEvent(window.location.href));
  };

  // Back/forward navigation
  window.addEventListener('popstate', () => {
    onView(createViewEvent(window.location.href));
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
