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
  let currentBase = '';
  const href = () => pageUrl(window.location.href, sanitizeUrl);

  const emit = (loadingType: ViewEvent['loading_type'], timings?: LoadTimings) => {
    currentUrl = href();
    currentBase = sanitizeUrl(window.location.href);
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
      const next = href();
      if (next === currentUrl) return;
      // A fragment that is not a route (an anchor, an OAuth token) never starts a view.
      if (next === currentBase && sanitizeUrl(window.location.href) === currentBase) return;
      emit('route_change');
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
  // Hash routers that assign location.hash.
  window.addEventListener('hashchange', navigated);

  return { restart: () => emit('route_change') };
}

// A hash route (#/path or #!/path) is part of the page, minimised like a path;
// any other fragment is dropped, as everywhere else.
export function pageUrl(href: string, sanitizeUrl: UrlSanitizer): string {
  const base = sanitizeUrl(href);
  const hash = typeof href === 'string' ? href.indexOf('#') : -1;
  const route = hash < 0 ? null : /^#(!?)(\/[\s\S]*)$/.exec(href.slice(hash));
  return route ? `${base}#${route[1]}${sanitizeUrl(route[2])}` : base;
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
