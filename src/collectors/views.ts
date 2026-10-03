import type { ViewEvent } from '../types';
import type { UrlSanitizer } from '../privacy/url';
import { uuid } from '../uuid';

export interface LoadTimings {
  load_time_ms: number;
  dom_ready_ms?: number;
}

export interface ViewCollectorOptions {
  /** The initial view's load timings, when the load finished after init. */
  onLoadTimings?: (timings: LoadTimings) => void;
  /** Every pushState, replaceState and popstate, whether or not the URL changed. */
  onHistoryChange?: () => void;
}

export interface ViewCollector {
  /** Starts a new view for the current URL (session rotation). */
  restart(): void;
}

// The initial view at once, then one per change of the sanitised URL, so router
// noise is not a page view. `sanitizeUrl` is required so no raw href slips out.
export function startViewCollector(
  onView: (view: ViewEvent) => void,
  sanitizeUrl: UrlSanitizer,
  options: ViewCollectorOptions = {},
): ViewCollector {
  let currentUrl = '';

  const emit = (loadingType: ViewEvent['loading_type'], timings?: LoadTimings) => {
    currentUrl = sanitizeUrl(window.location.href);
    onView({
      view_id: uuid(),
      url: currentUrl,
      timestamp: Date.now(),
      loading_type: loadingType,
      ...timings,
    });
  };

  const navigated = () => {
    try {
      options.onHistoryChange?.();
      if (sanitizeUrl(window.location.href) !== currentUrl) emit('route_change');
    } catch {
      // Never throw into the host's navigation call.
    }
  };

  const timings = readLoadTimings();
  emit('initial_load', timings ?? undefined);
  if (!timings && navigationEntry() && options.onLoadTimings) {
    whenLoaded(options.onLoadTimings);
  }

  for (const method of ['pushState', 'replaceState'] as const) {
    try {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        navigated();
        return result;
      };
    } catch {
      // A frozen history object: popstate still works.
    }
  }
  window.addEventListener('popstate', navigated);

  return { restart: () => emit('route_change') };
}

/** Load timings from Navigation Timing, or null until the load event has ended. */
export function readLoadTimings(): LoadTimings | null {
  const entry = navigationEntry();
  if (!entry || !(entry.loadEventEnd > 0)) return null;
  const domReady = entry.domContentLoadedEventEnd;
  return {
    load_time_ms: Math.round(entry.loadEventEnd),
    ...(domReady > 0 ? { dom_ready_ms: Math.round(domReady) } : {}),
  };
}

function navigationEntry(): PerformanceNavigationTiming | undefined {
  try {
    const [entry] = performance.getEntriesByType('navigation');
    return entry as PerformanceNavigationTiming | undefined;
  } catch {
    return undefined;
  }
}

// loadEventEnd is set once the load handlers return, so read one macrotask later.
function whenLoaded(onLoadTimings: (timings: LoadTimings) => void): void {
  const read = () =>
    setTimeout(() => {
      const timings = readLoadTimings();
      if (timings) onLoadTimings(timings);
    }, 0);
  if (document.readyState === 'complete') read();
  else window.addEventListener('load', read, { once: true });
}
