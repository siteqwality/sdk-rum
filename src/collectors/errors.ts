// An error as raised, for classification only and never sent: the pipeline in
// init.ts minimises every field before enqueueing, and again after beforeSend.
export interface RawError {
  message: string;
  stack: string;
  /** The script URL of an ErrorEvent, for the extension rule only. */
  filename: string;
  source: 'source' | 'console' | 'custom';
}

export function startErrorCollector(onError: (error: RawError) => void): void {
  window.addEventListener('error', (event) => {
    const raw = rawFromErrorEvent(event);
    if (raw) onError(raw);
  });
  window.addEventListener('unhandledrejection', (event) => {
    onError(rawFromRejection(event));
  });
}

/** A window `error` event, or null for anything that is not one. */
export function rawFromErrorEvent(event: unknown): RawError | null {
  const e = event as Partial<ErrorEvent> | null;
  if (!e || typeof e !== 'object') return null;
  const message = read(() => e.message);
  const error = read(() => e.error);
  if (typeof message !== 'string' && error === undefined) return null;
  return {
    message: typeof message === 'string' ? message : textOf(error),
    stack: stackOf(error),
    filename: str(read(() => e.filename)),
    source: 'source',
  };
}

/** An `unhandledrejection` event. Labelled `console`, as in every 1.x release. */
export function rawFromRejection(event: unknown): RawError {
  const reason = read(() => (event as PromiseRejectionEvent | null)?.reason);
  return { message: messageOf(reason, true), stack: stackOf(reason), filename: '', source: 'console' };
}

/** Anything passed to `addError`: an Error, an Error-like object, or any value. */
export function rawFromValue(value: unknown): RawError {
  return { message: messageOf(value, false), stack: stackOf(value), filename: '', source: 'custom' };
}

/** True for a value from an `error` or `unhandledrejection` listener. */
export function isRejectionEvent(event: unknown): boolean {
  const e = event as { type?: unknown } | null;
  return !!e && typeof e === 'object' && (e.type === 'unhandledrejection' || 'reason' in e);
}

// `emptyFallsBack` keeps 1.x: a rejection with an empty message used String(reason).
function messageOf(value: unknown, emptyFallsBack: boolean): string {
  if (!value || typeof value !== 'object') return textOf(value);
  const message = read(() => (value as { message?: unknown }).message);
  if (typeof message === 'string' && (message !== '' || !emptyFallsBack)) return message;
  return textOf(value);
}

function stackOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return str(read(() => (value as { stack?: unknown }).stack));
}

// String(value) throws for some objects, such as Object.create(null).
function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// Host objects and proxies can throw from a getter.
function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}
