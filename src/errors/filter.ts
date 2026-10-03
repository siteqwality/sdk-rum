// Noise rules, ignoreErrors and burst limits. The noise rules match core-rs
// common::rum::error_noise; both suites run error-noise-cases.json.

/** Schemes of browser extension and masked frames. */
export const EXTENSION_SCHEMES: readonly string[] = [
  'chrome-extension',
  'moz-extension',
  'safari-extension',
  'safari-web-extension',
  'webkit-masked-url',
  'ms-browser-extension',
];

const RESIZE_OBSERVER_PREFIXES = [
  'ResizeObserver loop completed with undelivered notifications',
  'ResizeObserver loop limit exceeded',
];

const SCRIPT_ERROR_MESSAGES = ['Script error.', 'Script error'];

// One frame URL per match; covers V8 `at f (url:l:c)` and Gecko/JSC `f@url:l:c`.
const FRAME_URL = /([a-z][a-z0-9+.-]*):\/\/[^\s()]+/g;

/** Trimmed, with one leading `Uncaught ` removed. */
export function normalizeErrorMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.startsWith('Uncaught ') ? trimmed.slice('Uncaught '.length) : trimmed;
}

/** The scheme of every frame URL in a stack, in order. */
export function frameSchemes(stack: string): string[] {
  const schemes: string[] = [];
  for (const match of stack.matchAll(FRAME_URL)) schemes.push(match[1]);
  return schemes;
}

/** ResizeObserver warnings, stackless "Script error.", extension-only frames; `filename` only without frames. */
export function isBrowserNoise(message: string, stack: string, filename = ''): boolean {
  const normalized = normalizeErrorMessage(message);
  if (RESIZE_OBSERVER_PREFIXES.some((p) => normalized.startsWith(p))) return true;
  const schemes = frameSchemes(stack);
  if (schemes.length === 0 && SCRIPT_ERROR_MESSAGES.includes(normalized)) return true;
  if (schemes.length > 0) return schemes.every((s) => EXTENSION_SCHEMES.includes(s));
  const fileSchemes = frameSchemes(filename);
  return fileSchemes.length > 0 && fileSchemes.every((s) => EXTENSION_SCHEMES.includes(s));
}

export type IgnoreErrorsMatcher = (normalizedMessage: string) => boolean;

/** A string matches as a case-sensitive substring, a RegExp is tested; anything else is skipped. */
export function createIgnoreErrorsMatcher(patterns: unknown): IgnoreErrorsMatcher {
  const list = Array.isArray(patterns) ? patterns : [];
  const strings = list.filter((p): p is string => typeof p === 'string' && p !== '');
  const regexps = list.filter((p): p is RegExp => p instanceof RegExp);
  if (strings.length === 0 && regexps.length === 0) return () => false;
  return (message) => {
    if (strings.some((s) => message.includes(s))) return true;
    return regexps.some((re) => {
      try {
        // A global or sticky RegExp would otherwise resume from its last match.
        re.lastIndex = 0;
        return re.test(message);
      } catch {
        return false;
      }
    });
  };
}

/** Errors sent from one page load, at most. */
export const MAX_ERRORS_PER_PAGE = 500;

/** Burst size per message, and one more allowed per refill interval after it. */
export const ERROR_BURST_CAPACITY = 10;
export const ERROR_REFILL_MS = 10_000;

/** Length of the message prefix that keys a bucket. */
export const RATE_LIMIT_KEY_LENGTH = 200;

const MAX_BUCKETS = 1_000;

/** A token bucket per message: 10 at once, then 1 per 10 s. */
export class ErrorRateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private capacity = ERROR_BURST_CAPACITY,
    private refillMs = ERROR_REFILL_MS,
  ) {}

  /** Takes a token for `key` if one is left. */
  allow(key: string, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (bucket) {
      const refill = (now - bucket.at) / this.refillMs;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, refill));
      bucket.at = now;
    } else {
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
      // Map order is insertion order, so this drops the oldest key.
      if (this.buckets.size > MAX_BUCKETS) {
        this.buckets.delete(this.buckets.keys().next().value as string);
      }
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

/** The rate limit key: the normalized message, cut. */
export function rateLimitKey(message: string): string {
  return normalizeErrorMessage(message).slice(0, RATE_LIMIT_KEY_LENGTH);
}
