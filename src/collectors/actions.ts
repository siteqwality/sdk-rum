import { cut } from '../text';

export interface CollectedAction {
  action_type: string;
  action_target: string;
  /** The name without element text, for clicks buffered before config. */
  action_target_hidden?: string;
  frustration?: 'rage_click' | 'dead_click' | 'error_click';
}

export const ACTION_NAME_ATTRIBUTE = 'data-sq-action-name';
export const NO_FRUSTRATION_ATTRIBUTE = 'data-sq-no-frustration';
const MAX_ACTION_NAME_LENGTH = 100;

/** How long a click waits for a reaction, an error or more clicks of a burst. */
export const FRUSTRATION_WINDOW_MS = 1000;
const RAGE_CLICKS = 3;
// A verdict this late means the page was blocked (alert, confirm, heavy work): no dead click.
const BLOCKED_LATENESS_MS = 250;
// Longest wait from a press (pointerdown, mousedown, Enter) to its click.
const PRESS_MAX_MS = 3000;

/** The element a click is named and grouped by. */
const TARGET_SELECTOR =
  'a, button, [role="button"], [role="link"], input, select, textarea, label, summary, [data-sq-action-name]';

/** Controls that are expected to react when clicked. */
const DEAD_CLICK_SELECTOR =
  'a[href], button:not([disabled]), [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="reset"], summary, [onclick]';

export interface ActionCollectorOptions<C> {
  /** Called at the click, before its window opens; returns the click's context. */
  begin: () => C;
  /** Called when the click's window closes (or the page hides), with its verdict. */
  emit: (action: CollectedAction, context: C) => void;
  /** Read per click, so a config refresh applies without a reload. */
  hideText?: () => boolean;
  /** Remote `frustration_ignore_selectors`, read per click. */
  ignoreSelectors?: () => readonly unknown[] | undefined;
  /** True for the SDK's own requests, which never count as a reaction. */
  isOwnRequest?: (url: string) => boolean;
}

export interface ActionCollector {
  /** A sent error: the latest pending click becomes an error click. */
  noteError(): void;
  /** A history change: every pending click reacted. */
  noteReaction(): void;
}

interface Burst {
  times: number[];
  last: number;
  raged: boolean;
}

/** A press on a control, watched because menus often open on pointerdown. */
interface Press {
  el: Element;
  at: number;
  perfTime: number;
  reacted: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface Pending<C> {
  context: C;
  action: CollectedAction;
  perfTime: number;
  burst: Burst | null;
  rage: boolean;
  deadCandidate: boolean;
  reacted: boolean;
  error: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Clicks, each emitted when its 1000 ms window closes with at most one signal:
 * error_click, then rage_click (one per burst), then dead_click.
 */
export function startActionCollector<C>(options: ActionCollectorOptions<C>): ActionCollector {
  const bursts = new WeakMap<Element, Burst>();
  let pending: Pending<C>[] = [];
  let press: Press | null = null;
  let watching = false;
  let ignoreSource: readonly unknown[] | undefined;
  let ignoreList: string[] = [];

  const markAllReacted = () => {
    for (const p of pending) p.reacted = true;
    if (press) press.reacted = true;
  };

  const mutations =
    typeof MutationObserver === 'function' ? new MutationObserver(markAllReacted) : null;
  const resources = createResourceWatcher((entries) => {
    for (const entry of entries) {
      if (options.isOwnRequest?.(entry.name)) continue;
      for (const p of pending) if (entry.startTime > p.perfTime) p.reacted = true;
      if (press && entry.startTime > press.perfTime) press.reacted = true;
    }
  });

  // Observers run only while a click or a press is pending.
  const watch = () => {
    if (watching) return;
    watching = true;
    try {
      mutations?.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      // No document element yet.
    }
    resources?.start();
  };

  const unwatch = () => {
    if (!watching || pending.length > 0 || press) return;
    watching = false;
    mutations?.disconnect();
    resources?.stop();
  };

  const clearPress = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
    unwatch();
  };

  const onPress = (event: Event) => {
    try {
      if (event.type === 'keydown') {
        const key = (event as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
      }
      const target = elementOf(event.target);
      if (!target) return;
      const resolved = resolveTarget(target);
      const now = Date.now();
      // pointerdown then mousedown on the same control is one press.
      if (press && press.el === resolved && now - press.at <= FRUSTRATION_WINDOW_MS) return;
      clearPress();
      if (!isDeadCandidate(resolved, event as MouseEvent)) return;
      press = { el: resolved, at: now, perfTime: perfNow(), reacted: false, timer: setTimeout(clearPress, PRESS_MAX_MS) };
      watch();
    } catch {
      // Never throw into the host's input handling.
    }
  };
  for (const type of ['pointerdown', 'mousedown', 'keydown']) {
    document.addEventListener(type, onPress, { capture: true });
  }

  // Records not yet delivered still count toward the verdict.
  const collectRecords = () => {
    if (mutations && mutations.takeRecords().length > 0) markAllReacted();
    resources?.drain();
  };

  const settle = (p: Pending<C>) => {
    clearTimeout(p.timer);
    pending = pending.filter((q) => q !== p);
    p.action.frustration = verdict(p);
    unwatch();
    options.emit(p.action, p.context);
  };

  const settleAll = () => {
    if (pending.length === 0) return;
    try {
      collectRecords();
      markAllReacted();
      for (const p of [...pending]) settle(p);
    } catch {
      // Monitoring must never break the host page.
    }
  };

  const currentIgnoreList = (): string[] => {
    const source = options.ignoreSelectors?.();
    if (source !== ignoreSource) {
      ignoreSource = source;
      ignoreList = validSelectors(source);
    }
    return ignoreList;
  };

  document.addEventListener(
    'click',
    (event) => {
      try {
        const target = elementOf(event.target);
        if (!target) return;
        const resolved = resolveTarget(target);
        const now = Date.now();
        const ignored = isIgnored(target, currentIgnoreList());

        let burst: Burst | null = null;
        let rage = false;
        if (!ignored) {
          burst = bursts.get(resolved) ?? null;
          if (!burst || now - burst.last > FRUSTRATION_WINDOW_MS) {
            burst = { times: [], last: now, raged: false };
            bursts.set(resolved, burst);
          }
          burst.times = burst.times.filter((t) => now - t <= FRUSTRATION_WINDOW_MS);
          burst.times.push(now);
          burst.last = now;
          if (!burst.raged && burst.times.length >= RAGE_CLICKS) {
            burst.raged = true;
            rage = true;
          }
        }

        // A reaction to the press that led to this click counts for the click.
        collectRecords();
        const pressed = press && press.el === resolved ? press : null;
        const context = options.begin();
        const p: Pending<C> = {
          context,
          action: {
            action_type: 'click',
            action_target: getSelector(resolved, options.hideText?.() === true),
            action_target_hidden: getSelector(resolved, true),
          },
          perfTime: pressed?.perfTime ?? perfNow(),
          burst,
          rage,
          deadCandidate: !ignored && isDeadCandidate(resolved, event),
          reacted: pressed?.reacted ?? false,
          error: false,
          timer: setTimeout(() => {
            try {
              collectRecords();
              if (Date.now() - now > FRUSTRATION_WINDOW_MS + BLOCKED_LATENESS_MS) p.reacted = true;
              settle(p);
            } catch {
              // Monitoring must never break the host page.
            }
          }, FRUSTRATION_WINDOW_MS),
        };
        pending.push(p);
        watch();
        clearPress();

        // A followed link or a submit starts a navigation; known after dispatch.
        if (p.deadCandidate) {
          setTimeout(() => {
            if (!event.defaultPrevented && startsNavigation(resolved)) p.reacted = true;
          }, 0);
        }
      } catch {
        // Never throw into the host's click handling.
      }
    },
    { capture: true },
  );

  const onReaction = () => markAllReacted();
  for (const type of ['popstate', 'hashchange', 'beforeunload', 'blur']) {
    window.addEventListener(type, onReaction);
  }
  document.addEventListener('submit', onReaction, { capture: true });

  // A hidden page may never come back, so pending clicks go out now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') settleAll();
  });
  window.addEventListener('pagehide', settleAll, { capture: true });

  return {
    noteError() {
      const latest = pending[pending.length - 1];
      if (latest) latest.error = true;
    },
    noteReaction: markAllReacted,
  };
}

function verdict(p: Pending<unknown>): CollectedAction['frustration'] {
  if (p.error) return 'error_click';
  if (p.rage) return 'rage_click';
  if (p.burst?.raged) return undefined;
  if (p.deadCandidate && !p.reacted) return 'dead_click';
  return undefined;
}

function elementOf(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Node).nodeType !== 'number') return null;
  const node = target as Node;
  if (node.nodeType === 1) return node as Element;
  return node.parentElement;
}

/** The closest interactive ancestor (or the element itself), else the element. */
export function resolveTarget(el: Element): Element {
  try {
    return el.closest(TARGET_SELECTOR) ?? el;
  } catch {
    return el;
  }
}

function isIgnored(target: Element, selectors: readonly string[]): boolean {
  try {
    if (target.closest(`[${NO_FRUSTRATION_ATTRIBUTE}]`)) return true;
  } catch {
    return false;
  }
  return selectors.some((selector) => {
    try {
      return target.closest(selector) !== null;
    } catch {
      return false;
    }
  });
}

/** The strings that parse as selectors; anything else is skipped. */
function validSelectors(source: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(source)) return [];
  const probe = document.createElement('div');
  return source.filter((s): s is string => {
    if (typeof s !== 'string' || s.trim() === '') return false;
    try {
      probe.matches(s);
      return true;
    } catch {
      return false;
    }
  });
}

function isDeadCandidate(el: Element, event: MouseEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
  try {
    if (!el.matches(DEAD_CLICK_SELECTOR)) return false;
    if (el.matches('a[download]')) return false;
    if (el.matches('a[target]')) {
      const target = (el.getAttribute('target') ?? '').trim().toLowerCase();
      if (target !== '' && target !== '_self') return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A link click that leaves the document (a same-page fragment fires hashchange instead). */
function startsNavigation(el: Element): boolean {
  if (!el.matches('a[href]')) return false;
  try {
    const url = new URL((el as HTMLAnchorElement).href, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const here = new URL(window.location.href);
    const samePage =
      url.origin === here.origin && url.pathname === here.pathname && url.search === here.search;
    return !(samePage && url.hash !== '');
  } catch {
    return false;
  }
}

function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : 0;
}

interface ResourceWatcher {
  start(): void;
  stop(): void;
  drain(): void;
}

function createResourceWatcher(
  onEntries: (entries: PerformanceEntry[]) => void,
): ResourceWatcher | null {
  if (typeof PerformanceObserver !== 'function') return null;
  const supported = PerformanceObserver.supportedEntryTypes;
  if (Array.isArray(supported) && !supported.includes('resource')) return null;
  let observer: PerformanceObserver | null = null;
  return {
    start() {
      if (observer) return;
      try {
        observer = new PerformanceObserver((list) => onEntries(list.getEntries()));
        observer.observe({ type: 'resource' });
      } catch {
        observer = null;
      }
    },
    stop() {
      observer?.disconnect();
      observer = null;
    },
    drain() {
      if (observer) onEntries(observer.takeRecords());
    },
  };
}

/**
 * Names a click: an explicit data-sq-action-name, else `#id`, else
 * `tag.classes[text]`, with the `[text]` suffix left off when `hideText`.
 */
export function getSelector(el: Element, hideText = false): string {
  const explicit = explicitActionName(el);
  if (explicit) return explicit;
  if (el.id) return `#${el.id}`;
  const tag = el.tagName?.toLowerCase() || 'unknown';
  // getAttribute, as an SVG element's className is not a string.
  const className = el.getAttribute?.('class')?.trim();
  const classes = className
    ? `.${className.split(/\s+/).slice(0, 2).join('.')}`
    : '';
  if (hideText) return `${tag}${classes}`;
  const text =
    cut(el.textContent?.trim() ?? '', 30) ||
    el.getAttribute?.('aria-label') ||
    '';
  const suffix = text ? `[${text}]` : '';
  return `${tag}${classes}${suffix}`;
}

// Brackets become parentheses so the ingest never reads them as a text suffix.
function explicitActionName(el: Element): string {
  const holder =
    typeof el.closest === 'function'
      ? el.closest(`[${ACTION_NAME_ATTRIBUTE}]`)
      : null;
  const raw = holder?.getAttribute(ACTION_NAME_ATTRIBUTE) ?? '';
  return cut(raw.trim(), MAX_ACTION_NAME_LENGTH)
    .trim()
    .replace(/\[/g, '(')
    .replace(/\]/g, ')');
}
