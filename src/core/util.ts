// Small helpers shared by every module. Nothing here may throw.

export const now = (): number => Date.now();

export const perfNow = (): number => {
  try {
    return performance.now();
  } catch {
    return 0;
  }
};

/** Epoch ms of a performance timestamp. */
export const epochOf = (perfTime: number): number => {
  try {
    return Math.round(performance.timeOrigin + perfTime);
  } catch {
    return now();
  }
};

export const isHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Cuts to at most `max` UTF-16 units without leaving half a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const out = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

/** UTF-8 length of a string, counted without encoding a copy of it. */
export function byteLength(text: string): number {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80) bytes += code >= 0x800 && (code < 0xd800 || code > 0xdfff) ? 2 : 1;
  }
  return bytes;
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Host objects and proxies can throw from a getter. */
export function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

export const round = (n: number): number => Math.round(n);
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The string-valued entries only, at most `max` of them. */
export function strings(value: unknown, max = 50): Record<string, string> | undefined {
  if (!isObj(value)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  try {
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (typeof v === 'string' && n++ < max) out[cut(key, 128)] = cut(v, 1024);
    }
  } catch {
    return undefined;
  }
  return n ? out : undefined;
}

/** A string array from untrusted config. */
export const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : [];

type StorageKind = 'localStorage' | 'sessionStorage';

/** Storage access that never throws (blocked storage, private mode, SSR). */
export const storage = {
  get(kind: StorageKind, key: string): string | null {
    try {
      return window[kind].getItem(key);
    } catch {
      return null;
    }
  },
  set(kind: StorageKind, key: string, value: string): boolean {
    try {
      window[kind].setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  del(kind: StorageKind, key: string): void {
    try {
      window[kind].removeItem(key);
    } catch {
      // Unavailable storage holds nothing to remove.
    }
  },
};

export function on(
  target: EventTarget,
  type: string,
  fn: (e: never) => void,
  opts: AddEventListenerOptions | boolean = { capture: true, passive: true },
): void {
  try {
    target.addEventListener(type, fn as EventListener, opts);
  } catch {
    // Monitoring must never break the host page.
  }
}

/** Percentile of a sorted copy; `q` in 0..1. */
export function pct(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}
