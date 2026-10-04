// Actions (design 5.6): clicks, taps, input changes and submits with a name and a stable
// selector; rage, dead and error clicks by Wave 1 F14, plus click counts and offsets.
import { cut, perfNow as clock } from '../core/util';

export type Frustration = 'rage_click' | 'dead_click' | 'error_click';

export interface CollectedAction {
  action_type: 'click' | 'tap' | 'input' | 'submit';
  name: string;
  /** The name without element text, for privacy settings that arrive later. */
  hiddenName: string;
  selector: string;
  frustration?: Frustration;
  click_count?: number;
  offset_pct?: [number, number];
  page_xy?: [number, number];
  viewport_w: number;
}

export const ACTION_NAME_ATTRIBUTE = 'data-sq-action-name';
export const NO_FRUSTRATION_ATTRIBUTE = 'data-sq-no-frustration';
/** How long a click waits for a reaction, an error or more clicks of a burst. */
export const FRUSTRATION_WINDOW_MS = 1000;

const TARGET = 'a,button,[role="button"],[role="link"],input,select,textarea,label,summary,[data-sq-action-name]';
const DEAD = 'a[href],button:not([disabled]),[role="button"],[role="link"],input[type="button"],input[type="submit"],input[type="reset"],summary,[onclick]';
const FIELD = 'input,select,textarea';

export interface ActionCollectorOptions<C> {
  /** The action's context, taken at the action; throws to skip it. */
  begin: () => C;
  emit: (action: CollectedAction, context: C) => void;
  hideText?: () => boolean;
  ignoreSelectors?: () => readonly unknown[] | undefined;
}

export interface ActionCollector {
  /** A sent error: the latest pending click becomes an error click. */
  noteError(): void;
  /** A history change or a request: every pending click and press reacted. */
  noteReaction(): void;
}

interface Burst {
  times: number[];
  raged: boolean;
}

interface Watch {
  el: Element;
  at: number;
  reacted: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface Pending<C> extends Watch {
  context: C;
  action: CollectedAction;
  burst: Burst | null;
  rage: boolean;
  dead: boolean;
  error: boolean;
}

const elementOf = (t: EventTarget | null): Element | null =>
  !t || typeof (t as Node).nodeType !== 'number' ? null : (t as Node).nodeType === 1 ? (t as Element) : (t as Node).parentElement;

const closest = (el: Element, s: string): Element | null => {
  try {
    return el.closest(s);
  } catch {
    return null;
  }
};

/** The closest interactive ancestor (or the element itself), else the element. */
export const resolveTarget = (el: Element): Element => closest(el, TARGET) ?? el;

function deadCandidate(el: Element, e: MouseEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
  try {
    const target = (el.getAttribute('target') ?? '').trim().toLowerCase();
    return el.matches(DEAD) && !el.matches('a[download]') && (!el.matches('a[target]') || target === '' || target === '_self');
  } catch {
    return false;
  }
}

/** A followed link leaves the document; a same-page fragment fires hashchange instead. */
function navigates(el: Element): boolean {
  try {
    if (!el.matches('a[href]')) return false;
    const u = new URL((el as HTMLAnchorElement).href, location.href);
    const here = new URL(location.href);
    return /^https?:$/.test(u.protocol) && !(u.origin + u.pathname + u.search === here.origin + here.pathname + here.search && u.hash);
  } catch {
    return false;
  }
}

const clean = (s: string | null | undefined) => cut((s ?? '').replace(/\s+/g, ' ').trim(), 64).trim();

/** data-sq-action-name on the element or an ancestor; brackets become parentheses. */
export const explicitName = (el: Element): string =>
  clean(closest(el, `[${ACTION_NAME_ATTRIBUTE}]`)?.getAttribute(ACTION_NAME_ATTRIBUTE)).replace(/\[/g, '(').replace(/\]/g, ')');

/** The explicit name, then aria-label, then text: a field's label or name, never its value. */
export function nameOf(el: Element): string {
  const named = explicitName(el) || clean(el.getAttribute('aria-label'));
  if (named) return named;
  if (el.matches(FIELD) || el.tagName === 'FORM') {
    return clean((el as HTMLInputElement).labels?.[0]?.textContent) || clean(el.getAttribute('name')) || clean(el.id);
  }
  return clean(el.textContent);
}

const STABLE = /^[A-Za-z][\w-]*$/;
const GENERATED = /^(css|sc|jsx|svelte|emotion)-|\d{3}|^_/;
const ok = (s: string) => STABLE.test(s) && !GENERATED.test(s);

/** id, data-testid, data-sq-*, tag and up to two classes, at most 4 levels. */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el, depth = 0; e && depth < 4 && !/^(HTML|BODY)$/.test(e.tagName); e = e.parentElement, depth++) {
    if (e.id && ok(e.id)) {
      parts.unshift(`#${e.id}`);
      break;
    }
    const attr = Array.from(e.attributes).find((a) => a.name === 'data-testid' || (a.name.startsWith('data-sq-') && a.name !== NO_FRUSTRATION_ATTRIBUTE));
    const value = attr && cut(attr.value, 64).replace(/["\\]/g, '');
    parts.unshift(
      e.tagName.toLowerCase() +
        (attr
          ? `[${attr.name}${value ? `="${value}"` : ''}]`
          : (e.getAttribute('class') || '').split(/\s+/).filter(ok).slice(0, 2).map((c) => `.${c}`).join('')),
    );
    if (attr?.name === 'data-testid') break;
  }
  return parts.join(' > ');
}

/**
 * Clicks, each emitted when its 1 s window closes with at most one signal: error_click, then
 * rage_click (the third click on a control within 1 s, one per burst), then dead_click.
 */
export function startActionCollector<C>(o: ActionCollectorOptions<C>): ActionCollector {
  const bursts = new WeakMap<Element, Burst>();
  let pending: Pending<C>[] = [];
  let press: Watch | null = null;
  let ignoreSrc: readonly unknown[] | undefined;
  let ignore: string[] = [];
  let lastPress: Element | null = null;
  let lastPressAt = 0;
  let tabbed = false;
  const all = (): Watch[] => (press ? [...pending, press] : pending);
  const react = () => all().forEach((w) => (w.reacted = true));
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(react) : null;
  let observing = false;
  // The DOM is watched only while a click or a press is pending.
  const sync = () => {
    const want = all().length > 0;
    if (want === observing) return;
    observing = want;
    try {
      if (want) mo?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      else mo?.disconnect();
    } catch {
      // No document element yet.
    }
  };
  const records = () => {
    if (mo?.takeRecords().length) react();
  };
  const clearPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
    sync();
  };

  const describe = (el: Element, type: CollectedAction['action_type']): CollectedAction => {
    const selector = selectorOf(el);
    const hiddenName = explicitName(el) || selector;
    return { action_type: type, name: o.hideText?.() ? hiddenName : nameOf(el) || hiddenName, hiddenName, selector, viewport_w: Math.round(innerWidth || 0) };
  };

  const settle = (p: Pending<C>) => {
    clearTimeout(p.timer);
    pending = pending.filter((q) => q !== p);
    sync();
    p.action.frustration = p.error ? 'error_click' : p.rage ? 'rage_click' : p.burst?.raged ? undefined : p.dead && !p.reacted ? 'dead_click' : undefined;
    if (p.rage) p.action.click_count = p.burst!.times.length;
    o.emit(p.action, p.context);
  };
  const settleAll = () => {
    records();
    react();
    [...pending].forEach(settle);
  };

  const listen = (target: EventTarget, types: string, fn: (e: never) => void, capture = true) => {
    for (const type of types.split(' ')) {
      target.addEventListener(type, ((e: Event) => {
        try {
          fn(e as never);
        } catch {
          // Inactive session, or never throw into the host's handlers.
        }
      }) as EventListener, { capture });
    }
  };

  // Menus often open on pointerdown: a reaction to the press counts for its click.
  listen(document, 'pointerdown mousedown keydown', (e: KeyboardEvent) => {
    lastPress = elementOf(e.target);
    lastPressAt = clock();
    tabbed = e.key === 'Tab';
    if ((e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') || !lastPress) return;
    const el = resolveTarget(lastPress);
    if (press?.el === el && lastPressAt - press.at <= FRUSTRATION_WINDOW_MS) return;
    clearPress();
    if (!deadCandidate(el, e as unknown as MouseEvent)) return;
    press = { el, at: lastPressAt, reacted: false, timer: setTimeout(clearPress, 3000) };
    sync();
  });

  // Focus moving elsewhere is a reaction (a field opened, a dialog), unless the user moved it.
  listen(document, 'focusin', (e: FocusEvent) => {
    const t = elementOf(e.target);
    const byUser = clock() - lastPressAt < 500 && (tabbed || (lastPress && (t?.contains(lastPress) || lastPress.contains(t))));
    if (t && !byUser) all().forEach((w) => !w.el.contains(t) && (w.reacted = true));
  });

  listen(document, 'click', (e: PointerEvent) => {
    const target = elementOf(e.target);
    if (!target) return;
    const el = resolveTarget(target);
    const now = clock();
    const src = o.ignoreSelectors?.();
    if (src !== ignoreSrc) {
      ignoreSrc = src;
      const probe = document.createElement('div');
      ignore = (Array.isArray(src) ? src : []).filter((s): s is string => {
        try {
          return typeof s === 'string' && !!s.trim() && (probe.matches(s), true);
        } catch {
          return false;
        }
      });
    }
    const ignored = !!closest(target, `[${NO_FRUSTRATION_ATTRIBUTE}]`) || ignore.some((s) => closest(target, s));
    let burst: Burst | null = null;
    let rage = false;
    if (!ignored) {
      burst = bursts.get(el) ?? null;
      const recent = burst?.times.filter((t) => now - t <= FRUSTRATION_WINDOW_MS) ?? [];
      if (!burst || !recent.length) bursts.set(el, (burst = { times: [], raged: false }));
      burst.times = [...recent, now];
      if (!burst.raged && burst.times.length >= 3) burst.raged = rage = true;
    }
    records();
    const pressed = press?.el === el ? press : null;
    const action = describe(el, e.pointerType === 'touch' ? 'tap' : 'click');
    if (e.detail > 0) {
      const r = el.getBoundingClientRect();
      const pct = (v: number, start: number, size: number) => (size > 0 ? Math.max(0, Math.min(100, Math.round(((v - start) / size) * 100))) : 0);
      action.offset_pct = [pct(e.clientX, r.left, r.width), pct(e.clientY, r.top, r.height)];
      action.page_xy = [Math.max(0, Math.round(e.pageX)), Math.max(0, Math.round(e.pageY))];
    }
    const p: Pending<C> = {
      context: o.begin(),
      action,
      el,
      at: now,
      burst,
      rage,
      dead: !ignored && deadCandidate(el, e),
      reacted: pressed?.reacted ?? false,
      error: false,
      timer: setTimeout(() => {
        try {
          records();
          // A verdict this late means the page was blocked (alert, confirm, heavy work).
          if (clock() - now > FRUSTRATION_WINDOW_MS + 250) p.reacted = true;
          settle(p);
        } catch {
          // Monitoring must never break the host page.
        }
      }, FRUSTRATION_WINDOW_MS),
    };
    pending.push(p);
    clearPress();
    sync();
    if (p.dead) setTimeout(() => !e.defaultPrevented && navigates(el) && (p.reacted = true));
  });

  // Field changes and submits: names only, never values.
  listen(document, 'change submit', (e: Event) => {
    const el = elementOf(e.target);
    if (!el) return;
    if (e.type === 'submit') {
      react();
      if (el.tagName !== 'FORM') return;
    } else if (!el.matches(FIELD) || el.matches('input[type="hidden" i]')) return;
    o.emit(describe(el, e.type === 'submit' ? 'submit' : 'input'), o.begin());
  });

  // The window's own blur (another tab or app); a capture listener would see every field's blur.
  listen(window, 'popstate hashchange beforeunload blur', react, false);
  listen(document, 'visibilitychange', () => document.visibilityState === 'hidden' && settleAll());
  listen(window, 'pagehide', settleAll);

  return {
    noteError() {
      const latest = pending[pending.length - 1];
      if (latest) latest.error = true;
    },
    noteReaction: react,
  };
}
