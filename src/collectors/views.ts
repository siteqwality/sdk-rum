// Views (design 5.6): view_start on load, URL change and back-forward cache restore; view_end
// interim on hide and every 5 min, final on the next view and pagehide, with an increasing seq.
import type { SqEvent } from '../types';
import { OBSERVE, type Hub } from '../hub';
import { createUrlSanitizer, type UrlSanitizer } from '../core/url';
import { uuid } from '../core/hash';
import { now, perfNow, round, isHidden, isNum, storage, cut, on } from '../core/util';

const INTERIM_MS = 5 * 60_000;
const ACTIVE_WINDOW_MS = 5_000;
const SETTLE_MS = 100;
const LOADING_CAP_MS = 10_000;
const UTM = ['source', 'medium', 'campaign', 'content', 'term'];
const CLICK_IDS = ['gclid', 'fbclid', 'msclkid', 'ttclid'];

export type LoadingType = 'initial_load' | 'route_change' | 'bfcache_restore';

export interface View {
  id: string;
  sid: string;
  url: string;
  /** The URL without any fragment, for telling routes from anchors. */
  base: string;
  start: number;
  startEvent: SqEvent;
  seq: number;
  ended: boolean;
  errors: number;
  actions: number;
  frustrations: number;
  activeAtStart: number;
  scroll?: number;
  height?: number;
  fold?: number;
  m: Record<string, unknown>;
}

const strict = createUrlSanitizer();

/** A `#/route` (or `#!/route`) kept like a path when hash routing is on; any other fragment is dropped. */
export function pageUrl(href: string, sanitize: UrlSanitizer, hashRouting = true): string {
  const base = sanitize(href);
  if (!hashRouting || typeof href !== 'string') return base;
  const at = href.trim().indexOf('#');
  const route = at < 0 ? null : /^(!?)(\/[\s\S]*)$/.exec(href.trim().slice(at + 1));
  if (!route || /[=&]/.test(strict(route[2]))) return base;
  return `${base}#${route[1]}${sanitize(route[2])}`;
}

function navEntry(): PerformanceNavigationTiming | undefined {
  try {
    return performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  } catch {
    return undefined;
  }
}

export interface ViewsOptions {
  /** Session id for a new view; may rotate an expired session. */
  session: () => { id: string; isNew: boolean };
  onView: (view: View) => void;
  /** Every history change, URL changed or not (dead-click reactions). */
  onHistory?: () => void;
  /** Whether a view's session is still live; interim updates stop when it expires. */
  live?: (sid: string) => boolean;
}

export type Views = ReturnType<typeof startViews>;

export function startViews(h: Hub, o: ViewsOptions) {
  const hashRouting = h.opts.hashRouting === true;
  const href = () => pageUrl(location.href, h.url, hashRouting);
  let current!: View;
  let initial!: View;
  let firstOfPage = true;

  // Active time: each input counts the 5 s after it, while visible.
  let actSid = '';
  let actBase = 0;
  let acc = 0;
  let mark = 0;
  let until = 0;
  const activeTotal = (t = now()) => actBase + acc + Math.max(0, Math.min(t, until) - mark);
  function closeActive(t = now()) {
    acc += Math.max(0, Math.min(t, until) - mark);
    mark = until = t;
    storage.set('sessionStorage', '_sq_act', `${actSid}|${actBase + acc}`);
  }
  function resetActive(sid: string) {
    const [s, ms] = (storage.get('sessionStorage', '_sq_act') || '').split('|');
    actSid = sid;
    actBase = s === sid && isNum(+ms) ? +ms : 0;
    acc = mark = until = 0;
  }

  // Route-change loading time (Datadog's definition): until 100 ms pass with no new request or mutation.
  let loading: { view: View; start: number; last: number; pending: number; timer?: ReturnType<typeof setTimeout>; mo?: MutationObserver } | null = null;
  function stopLoading(value?: number) {
    if (!loading) return;
    clearTimeout(loading.timer);
    loading.mo?.disconnect();
    if (value !== undefined) loading.view.m.loading_time_ms = round(Math.min(LOADING_CAP_MS, Math.max(0, value)));
    loading = null;
  }
  function loadingTick() {
    if (!loading) return;
    loading.last = perfNow();
    clearTimeout(loading.timer);
    if (loading.last - loading.start >= LOADING_CAP_MS) return stopLoading(LOADING_CAP_MS);
    loading.timer = setTimeout(() => {
      if (loading && !loading.pending) stopLoading(loading.last - loading.start);
    }, SETTLE_MS);
  }

  function emitEnd(view: View, final: boolean): void {
    if (view.ended && !final) return;
    view.seq++;
    view.ended = final;
    const t = now();
    const e: SqEvent = {
      k: 'view_end',
      t,
      view_id: view.id,
      seq: view.seq,
      final,
      time_spent_ms: Math.max(0, t - view.start),
      active_ms: round(Math.max(0, activeTotal(t) - view.activeAtStart)),
      session_active_ms: round(activeTotal(t)),
      ...view.m,
      ...(view.scroll !== undefined ? { scroll_depth_pct: view.scroll, page_height_px: view.height, fold_px: view.fold } : {}),
      errors: view.errors,
      actions: view.actions,
      frustrations: view.frustrations,
    };
    h.emit(e, OBSERVE, { kind: 'view', sid: view.sid });
  }

  function start(type: LoadingType, navigationType: string): void {
    if (current && !current.ended) emitEnd(current, true);
    stopLoading();
    const s = o.session();
    if (s.id !== actSid) resetActive(s.id);
    const url = href();
    const id = uuid();
    const route = routeOf(url);
    const startEvent: SqEvent = {
      k: 'view_start',
      t: now(),
      view_id: id,
      url,
      ...(route ? { route } : {}),
      loading_type: type,
      navigation_type: navigationType,
    };
    if (s.isNew && firstOfPage) Object.assign(startEvent, acquisition());
    firstOfPage = false;
    current = { id, sid: s.id, url, base: h.url(location.href), start: startEvent.t, startEvent, seq: 0, ended: false, errors: 0, actions: 0, frustrations: 0, activeAtStart: activeTotal(), m: {} };
    if (!initial) initial = current;
    measureScroll();
    o.onView(current);
    h.emit(startEvent, OBSERVE, { kind: 'view', sid: s.id });
    if (type === 'route_change') {
      loading = { view: current, start: perfNow(), last: perfNow(), pending: 0 };
      try {
        loading.mo = new MutationObserver(loadingTick);
        loading.mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch {
        // No observer: the timer alone decides.
      }
      loadingTick();
    }
  }

  function routeOf(url: string): string | undefined {
    const fn = h.opts.routeName;
    if (typeof fn !== 'function') return undefined;
    try {
      const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') || '/';
      const r = fn(path);
      return typeof r === 'string' && r ? cut(r, 256) : undefined;
    } catch {
      return undefined;
    }
  }

  function acquisition(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const ref = strict(document.referrer);
    if (ref) out.referrer = ref;
    try {
      const q = new URLSearchParams(location.search);
      const utm: Record<string, string> = {};
      for (const k of UTM) {
        const v = q.get(`utm_${k}`);
        if (v) utm[k] = cut(h.scrub(v), 256);
      }
      if (Object.keys(utm).length) out.utm = utm;
      const click = CLICK_IDS.find((k) => q.has(k));
      if (click) out.click_id_type = click;
    } catch {
      // No URLSearchParams.
    }
    return out;
  }

  function measureScroll(): void {
    try {
      const el = document.documentElement;
      const height = Math.max(el.scrollHeight, document.body?.scrollHeight ?? 0);
      const fold = window.innerHeight;
      if (!height || !fold) return;
      const depth = round(Math.min(100, ((window.scrollY + fold) / height) * 100));
      current.scroll = Math.max(current.scroll ?? 0, depth);
      current.height = Math.max(current.height ?? 0, height);
      current.fold = fold;
    } catch {
      // Detached document.
    }
  }

  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  on(window, 'scroll', () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      measureScroll();
    }, 200);
  });

  const nav = navEntry();
  const initialNav = (nav?.type || 'navigate').replace(/-/g, '_');
  start('initial_load', initialNav);
  const loadTimings = () => {
    const n = navEntry();
    if (!n || !(n.loadEventEnd > 0)) return false;
    initial.m.loading_time_ms = initial.m.load_event_ms = round(n.loadEventEnd);
    if (n.domContentLoadedEventEnd > 0) initial.m.dom_content_loaded_ms = round(n.domContentLoadedEventEnd);
    return true;
  };
  if (!loadTimings()) on(window, 'load', () => setTimeout(() => loadTimings() && lateUpdate(initial), 0), { once: true });

  const navigated = (type: string) => () => {
    try {
      o.onHistory?.();
      const next = href();
      const base = h.url(location.href);
      // An anchor or token fragment on the same page is not a route: no new view.
      if (next !== current.url && !(next === base && base === current.base)) start('route_change', type);
    } catch {
      // Never throw into the host's navigation.
    }
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    try {
      const original = history[method];
      const after = navigated(method === 'pushState' ? 'push' : 'replace');
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        after();
        return result;
      };
    } catch {
      // A frozen history object: popstate still works.
    }
  }
  on(window, 'popstate', navigated('pop'), false);
  on(window, 'hashchange', navigated('hash'), false);

  // Late vitals and timings for a view already ended go out as one more final view_end.
  const lateQueued = new Set<View>();
  function lateUpdate(view: View): void {
    if (!view.ended || lateQueued.has(view)) return;
    lateQueued.add(view);
    void Promise.resolve().then(() => {
      lateQueued.delete(view);
      emitEnd(view, true);
    });
  }

  setInterval(() => {
    if (!isHidden() && current && !current.ended && (o.live?.(current.sid) ?? true)) emitEnd(current, false);
  }, INTERIM_MS);

  return {
    get current(): View {
      return current;
    },
    get initial(): View {
      return initial;
    },
    restart(type: LoadingType = 'route_change', navigationType = 'session'): void {
      start(type, navigationType);
    },
    /** setView(): the route of the current view; applied to its view_start if not yet sent. */
    setRoute(name: string): void {
      current.startEvent.route = name;
    },
    /** A vital of the document's initial view (design 5.6). */
    vital(fields: Record<string, unknown>): void {
      Object.assign(initial.m, fields);
      lateUpdate(initial);
    },
    input(t = now()): void {
      if (t <= until) until = t + ACTIVE_WINDOW_MS;
      else {
        acc += Math.max(0, until - mark);
        mark = t;
        until = t + ACTIVE_WINDOW_MS;
      }
    },
    /** A request started: it holds the route-change loading time open until it ends. */
    netStart(): (() => void) | undefined {
      if (!loading) return undefined;
      const l = loading;
      l.pending++;
      loadingTick();
      return () => {
        l.pending--;
        if (loading === l) loadingTick();
      };
    },
    hide(): void {
      closeActive();
      measureScroll();
      if (!current.ended) emitEnd(current, false);
    },
    pagehide(): void {
      closeActive();
      measureScroll();
      stopLoading();
      if (!current.ended) emitEnd(current, true);
    },
  };
}
