// Console (design 5.6): the configured levels, arguments serialised to depth 3 and 2 KB, 50
// entries per 10 s per level, identical consecutive lines folded. Output is never changed.
import { ANALYZE, type Hub } from '../hub';
import { cut, read } from '../core/util';

const LEVELS = ['error', 'warn', 'info', 'log', 'debug'] as const;
const MAX_ENTRY = 2_048;
const RATE = 50;
const RATE_MS = 10_000;
const FOLD_MS = 1_000;
/** The SDK's own messages are never recorded. */
export const OWN_PREFIX = '[SiteQwality';

/** A console argument as text: depth 3, cycles and host objects safe, never throws. */
export function serialize(value: unknown, depth = 0, seen: unknown[] = []): string {
  try {
    if (typeof value === 'string') return depth ? JSON.stringify(value) : value;
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
      if (typeof value === 'bigint') return `${value}n`;
      return String(value);
    }
    if (seen.includes(value)) return '[circular]';
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof Node === 'function' && value instanceof Node) return `<${(value as Element).tagName?.toLowerCase() || value.nodeName}>`;
    if (depth >= 3) return Array.isArray(value) ? '[array]' : '[object]';
    const next = [...seen, value];
    const inner = (v: unknown) => serialize(v, depth + 1, next);
    if (Array.isArray(value)) return `[${value.slice(0, 20).map(inner).join(', ')}]`;
    if (value instanceof Map) return `Map {${Array.from(value).slice(0, 20).map(([k, v]) => `${inner(k)} => ${inner(v)}`).join(', ')}}`;
    if (value instanceof Set) return `Set {${Array.from(value).slice(0, 20).map(inner).join(', ')}}`;
    const keys = Object.keys(value).slice(0, 20);
    return `{${keys.map((k) => `${k}: ${inner((value as Record<string, unknown>)[k])}`).join(', ')}}`;
  } catch {
    return '[unserializable]';
  }
}

export type Console = ReturnType<typeof startConsole>;

export function startConsole(h: Hub, crumb: (message: string) => void) {
  const wrapped = new Set<string>();
  const counts: Record<string, { n: number; at: number }> = {};
  let held: { level: string; message: string; stack?: string; t: number; view: string; repeat: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  function release(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!held) return;
    const { level, message, stack, t, view, repeat } = held;
    held = null;
    h.emit({ k: 'console', t, view_id: view, level, message, ...(stack ? { stack } : {}), repeat }, ANALYZE, { kind: 'console' });
  }

  function record(level: string, args: unknown[]): void {
    if (busy) return;
    busy = true;
    try {
      const raw = args.map((a) => serialize(a)).join(' ');
      if (raw.startsWith(OWN_PREFIX)) return;
      const message = cut(h.scrub(h.text(cut(raw, MAX_ENTRY * 2))), MAX_ENTRY);
      if (level === 'error') crumb(message);
      if (!h.cfg().capture.console.includes(level)) return;
      if (held && held.level === level && held.message === message) {
        held.repeat++;
        return;
      }
      const c = (counts[level] ||= { n: 0, at: Date.now() });
      if (Date.now() - c.at > RATE_MS) {
        c.n = 0;
        c.at = Date.now();
      }
      if (++c.n > RATE) return h.count('console_rate_limited');
      release();
      const err = args.find((a) => a instanceof Error) as Error | undefined;
      const stack = err && typeof err.stack === 'string' ? cut(h.text(err.stack), MAX_ENTRY * 4) : undefined;
      held = { level, message, stack, t: Date.now(), view: h.viewId(), repeat: 1 };
      timer = setTimeout(release, FOLD_MS);
    } finally {
      busy = false;
    }
  }

  /** Wraps the configured levels, and error always (breadcrumbs); never unwraps. */
  function sync(): void {
    const want = new Set<string>(['error', ...h.cfg().capture.console]);
    for (const level of LEVELS) {
      if (!want.has(level) || wrapped.has(level)) continue;
      const original = read(() => console[level]);
      if (typeof original !== 'function') continue;
      wrapped.add(level);
      try {
        console[level] = function (this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args);
          try {
            record(level, args);
          } catch {
            // Monitoring must never break the host page.
          }
          return result;
        };
      } catch {
        // A frozen console.
      }
    }
  }

  sync();
  return { sync, flush: release };
}
