// Errors (design 5.7): capture, noise rules N1 to N9, ignore and deny lists, suppressed keys,
// repeat folding, a burst limit per error_key, cause chains, breadcrumbs and Debug IDs.
import type { SqEvent } from '../types';
import { OBSERVE, type Hub } from '../hub';
import { uuid } from '../core/hash';
import { parseStack, topFrame, normalisePath, splitErrorMessage, errorKey, hasLocation } from '../core/stack';
import { cut, now, read, str, isHidden, strings, on, byteLength } from '../core/util';

export interface Cause {
  type: string;
  message: string;
  stack: string;
}

/** An error as raised; never sent before the pipeline minimises it. */
export interface RawError {
  type: string;
  message: string;
  stack: string;
  handling: 'unhandled' | 'unhandledrejection' | 'handled';
  /** The message as Wave 1 read it, for the shared noise cases and ignoreErrors. */
  raw: string;
  filename?: string;
  cause?: Cause[];
}

const MAX_MESSAGE = 4_096;
const MAX_STACK = 16_384;
const MAX_CRUMB_BYTES = 8_192;
export const MAX_ERRORS_PER_PAGE = 500;
export const BURST = 10;
export const REFILL_MS = 10_000;
export const FOLD_MS = 5_000;

export const EXTENSION_SCHEMES = [
  'chrome-extension',
  'moz-extension',
  'safari-extension',
  'safari-web-extension',
  'webkit-masked-url',
  'ms-browser-extension',
];
const FRAME_URL = /([a-z][a-z0-9+.-]*):\/\/[^\s()]+/g;

/** Trimmed, with one leading `Uncaught ` removed (Wave 1 D9). */
export const normalizeMessage = (m: string): string => {
  const t = m.trim();
  return t.startsWith('Uncaught ') ? t.slice(9) : t;
};

const schemes = (s: string): string[] => Array.from(s.matchAll(FRAME_URL), (m) => m[1]);
const allExtension = (list: string[]) => list.length > 0 && list.every((s) => EXTENSION_SCHEMES.includes(s));

// N4 to N9: the rest of Sentry's DEFAULT_IGNORE_ERRORS, tested on the split message.
const NOISE: Array<[string, RegExp]> = [
  ['n4', /^Javascript error: Script error\.? on line 0$/],
  ['n5', /^Cannot redefine property: googletag$/],
  ['n6', /^Can't find variable: gmo$/],
  ['n7', /^Can't find variable: _AutofillCallbackHandler$/],
  ['n8', /^(?:Non-Error promise rejection captured with value: )?Object Not Found Matching Id:\d+, MethodName:simulateEvent, ParamCount:\d+$/],
  ['n9', /^Java object is gone$/],
];

/** The noise rule an error matches (Wave 1 D9 N1 to N3, then N4 to N9), or null. */
export function noiseRule(message: string, stack: string, filename = '', split = splitErrorMessage(message)[1]): string | null {
  const m = normalizeMessage(message);
  if (/^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/.test(m)) return 'n1';
  const frames = schemes(stack);
  if (!frames.length && (m === 'Script error.' || m === 'Script error')) return 'n2';
  if (frames.length ? allExtension(frames) : allExtension(schemes(filename))) return 'n3';
  for (const [rule, re] of NOISE) if (re.test(split.trim())) return rule;
  return null;
}

/** A string matches as a substring, a RegExp is tested; anything else is skipped. */
export function createMatcher(patterns: unknown): (text: string) => boolean {
  const list = Array.isArray(patterns) ? patterns : [];
  const strs = list.filter((p): p is string => typeof p === 'string' && p !== '');
  const res = list.filter((p): p is RegExp => p instanceof RegExp);
  if (!strs.length && !res.length) return () => false;
  return (text) =>
    strs.some((s) => text.includes(s)) ||
    res.some((re) => {
      try {
        re.lastIndex = 0;
        return re.test(text);
      } catch {
        return false;
      }
    });
}

function textOf(v: unknown): string {
  try {
    if (typeof v === 'string') return v;
    const json = JSON.stringify(v);
    return cut(json === undefined ? String(v) : json, 1024);
  } catch {
    return read(() => String(v)) ?? Object.prototype.toString.call(v);
  }
}

const errorLike = (v: unknown): v is { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown } =>
  !!v && typeof v === 'object' && (typeof read(() => (v as Error).message) === 'string' || typeof read(() => (v as Error).stack) === 'string');

function causes(err: unknown): Cause[] | undefined {
  const out: Cause[] = [];
  let c: unknown = read(() => (err as { cause?: unknown }).cause);
  for (let i = 0; i < 3 && c !== undefined && c !== null; i++) {
    if (!errorLike(c)) {
      out.push({ type: 'Error', message: textOf(c), stack: '' });
      break;
    }
    const e = c;
    out.push({ type: str(read(() => e.name)) || 'Error', message: str(read(() => e.message)) ?? '', stack: str(read(() => e.stack)) ?? '' });
    c = read(() => e.cause);
  }
  return out.length ? out : undefined;
}

/** addError and rejections: an Error, anything Error-like, or any value. */
export function fromValue(v: unknown, handling: RawError['handling'] = 'handled', fallbackType = 'Error'): RawError {
  if (errorLike(v)) {
    const message = str(read(() => v.message)) ?? '';
    return {
      type: str(read(() => v.name)) || 'Error',
      message,
      stack: str(read(() => v.stack)) ?? '',
      handling,
      raw: message,
      cause: causes(v),
    };
  }
  const message = textOf(v);
  return { type: fallbackType, message, stack: '', handling, raw: message };
}

/** A window `error` event, or null for anything else. */
export function fromErrorEvent(event: unknown): RawError | null {
  const e = event as Partial<ErrorEvent> | null;
  if (!e || typeof e !== 'object') return null;
  const message = read(() => e.message);
  const error = read(() => e.error);
  if (typeof message !== 'string' && error === undefined) return null;
  const filename = str(read(() => e.filename)) ?? '';
  if (errorLike(error)) return { ...fromValue(error, 'unhandled'), raw: typeof message === 'string' ? message : '', filename };
  const raw = typeof message === 'string' ? message : textOf(error);
  const [type, msg] = splitErrorMessage(raw);
  return { type, message: msg, stack: '', handling: 'unhandled', raw, filename };
}

export function fromRejection(event: unknown): RawError {
  return fromValue(read(() => (event as PromiseRejectionEvent).reason), 'unhandledrejection', 'UnhandledRejection');
}

export const isRejectionEvent = (e: unknown): boolean =>
  !!e && typeof e === 'object' && ((e as Event).type === 'unhandledrejection' || 'reason' in e);

export function listenErrors(report: (raw: RawError) => void): void {
  on(window, 'error', (e: ErrorEvent) => {
    const raw = fromErrorEvent(e);
    if (raw) report(raw);
  }, false);
  on(window, 'unhandledrejection', (e: PromiseRejectionEvent) => report(fromRejection(e)), false);
}

/** Debug IDs registered by `siteqwality sourcemaps inject`: stack key to id, mapped per file URL. */
function debugIds(h: Hub): Map<string, string> {
  const map = new Map<string, string>();
  const reg = read(() => (globalThis as { _sqDebugIds?: Record<string, string> })._sqDebugIds);
  if (!reg || typeof reg !== 'object') return map;
  for (const key of Object.keys(reg)) {
    const file = topFrame(parseStack(key))?.file;
    if (file && typeof reg[key] === 'string') map.set(h.url(file), reg[key]);
  }
  return map;
}

export interface ErrorPipelineOptions {
  /** Breadcrumbs to attach, oldest first. */
  crumbs: () => unknown[];
  /** True when there is no session to attach the error to (a hidden tab whose session expired). */
  orphan: () => boolean;
  /** After a sent error: rule input, view counts, error clicks. */
  sent: (raw: RawError, e: SqEvent) => void;
}

export type ErrorPipeline = ReturnType<typeof createErrorPipeline>;

export function createErrorPipeline(h: Hub, o: ErrorPipelineOptions) {
  const ignore = createMatcher(h.opts.ignoreErrors);
  const deny = createMatcher(h.opts.denyUrls);
  const buckets = new Map<number, { tokens: number; at: number }>();
  const folds = new Map<string, { n: number; e: SqEvent; raw: RawError }>();
  let sent = 0;
  let ids = new Map<string, string>();
  let idCount = -1;
  let inHook = false;

  function allow(key: number, t: number): boolean {
    let b = buckets.get(key);
    if (b) {
      b.tokens = Math.min(BURST, b.tokens + Math.max(0, (t - b.at) / REFILL_MS));
      b.at = t;
    } else {
      b = { tokens: BURST, at: t };
      buckets.set(key, b);
      if (buckets.size > 1000) buckets.delete(buckets.keys().next().value as number);
    }
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  /** Message and non-frame stack lines are scrubbed; frame lines keep their file paths. */
  function cleanStack(stack: string): string {
    const urls = h.text(cut(stack, MAX_STACK));
    return urls
      .split('\n')
      .map((line) => (parseStack(line).some((f) => hasLocation(f.file)) ? line : h.scrub(line)))
      .join('\n');
  }

  function attachIds(frames: string[]): Record<string, string> | undefined {
    const reg = read(() => (globalThis as { _sqDebugIds?: object })._sqDebugIds);
    const n = reg && typeof reg === 'object' ? Object.keys(reg).length : 0;
    if (n !== idCount) {
      idCount = n;
      ids = n ? debugIds(h) : new Map();
    }
    if (!ids.size) return undefined;
    const out: Record<string, string> = {};
    for (const f of frames) {
      const id = ids.get(f);
      if (id) out[f] = id;
    }
    return Object.keys(out).length ? out : undefined;
  }

  function trimCrumbs(list: unknown[]): unknown[] | undefined {
    const out = list.slice(-30);
    while (out.length && byteLength(JSON.stringify(out)) > MAX_CRUMB_BYTES) out.shift();
    return out.length ? out : undefined;
  }

  function deliver(raw: RawError, e: SqEvent): void {
    if (h.emit(e, OBSERVE, { kind: 'error', rotate: true, urgent: true })) o.sent(raw, e);
  }

  return {
    /** `context` comes from addError; `sq.fingerprint` in it sets a custom fingerprint. */
    report(raw: RawError, t: number = now(), context?: unknown): void {
      if (inHook) return;
      const cfg = h.cfg().capture.errors;
      const noise = noiseRule(raw.raw || raw.message, raw.stack, raw.filename, raw.message);
      if (noise) return h.count(`noise_${noise}`);
      const full = `${raw.type}: ${raw.message}`;
      if (ignore(normalizeMessage(raw.raw || raw.message)) || ignore(full) || cfg.ignore.some((p) => full.includes(p))) {
        return h.count('ignored_error');
      }
      const frames = parseStack(raw.stack);
      const top = topFrame(frames)?.file ?? raw.filename ?? '';
      if (top && (deny(top) || cfg.deny_urls.some((p) => top.includes(p)))) return h.count('denied_error');
      if (isHidden() && o.orphan()) return;

      const message = h.scrub(h.text(cut(raw.message, MAX_MESSAGE)));
      const stack = cleanStack(raw.stack);
      const key = errorKey(raw.type, message, normalisePath(topFrame(parseStack(stack))?.file ?? ''));
      if (cfg.suppressed_keys.includes(key)) return h.count('suppressed_error');
      if (sent >= MAX_ERRORS_PER_PAGE) return h.count('rate_limited_error');

      const foldKey = `${key}|${message}|${stack}`;
      const fold = folds.get(foldKey);
      if (fold) {
        fold.n++;
        fold.e.t = t;
        return;
      }
      if (!allow(key, t)) return h.count('rate_limited_error');

      const ctx = strings(context) ?? {};
      const fingerprint = ctx['sq.fingerprint'];
      delete ctx['sq.fingerprint'];
      const cause = raw.cause?.map((c) => ({ type: c.type, message: h.scrub(h.text(cut(c.message, MAX_MESSAGE))), stack: cleanStack(c.stack) }));
      const e: SqEvent = {
        k: 'error',
        t,
        view_id: h.viewId(),
        id: uuid(),
        error_type: cut(raw.type, 128),
        message,
        stack,
        handling: raw.handling,
        error_key: key,
        repeat: 1,
        ...(cause ? { cause } : {}),
        ...((() => {
          const d = attachIds(parseStack(stack).map((f) => f.file));
          return d ? { debug_ids: d } : {};
        })()),
        ...((() => {
          const b = trimCrumbs(o.crumbs());
          return b ? { breadcrumbs: b } : {};
        })()),
        ...(Object.keys(ctx).length ? { context: ctx } : {}),
        ...(fingerprint ? { fingerprint: cut(fingerprint, 256) } : {}),
      };
      sent++;
      // Later identical errors within FOLD_MS go out once more as one event with their count.
      const entry = { n: 0, e: { ...e }, raw };
      folds.set(foldKey, entry);
      setTimeout(() => {
        folds.delete(foldKey);
        if (entry.n && sent < MAX_ERRORS_PER_PAGE) {
          sent++;
          deliver(raw, { ...entry.e, id: uuid(), repeat: entry.n });
        }
      }, FOLD_MS);
      inHook = true;
      try {
        deliver(raw, e);
      } finally {
        inHook = false;
      }
    },
  };
}
