/** Serialized canvas bytes, before gzip, including the ring's frames. */
export const CANVAS_MAX_BYTES = 20_000_000;
export const CANVAS_BUDGET_KEY = '_sq_cb';
type Store = 'localStorage' | 'sessionStorage' | undefined;
type Result = 'ok' | 'cap' | 'unavailable';
type Counter = { bytes: number; capped: boolean; expires: number };
const memory = new Map<string, Counter>();

/** Web Locks make same-origin tabs' read/check/write one operation. Never writes after stop. */
export function canvasBudget(session: string, store?: Store, now = Date.now) {
  let used = 0;
  const available = store !== 'localStorage' || typeof navigator.locks?.request === 'function';
  const reserve = (bytes: number, active: () => boolean): Promise<Result> => {
    const take = (): Result => {
      if (!available || !active() || !Number.isSafeInteger(bytes) || bytes < 0) return 'unavailable';
      try {
        const counters: Map<string, Counter> = store ? new Map(JSON.parse(window[store].getItem(CANVAS_BUDGET_KEY) || '[]')) : memory;
        const t = now();
        for (const [sid, c] of counters) {
          if (!c || !Number.isSafeInteger(c.bytes) || c.bytes < 0 || c.bytes > CANVAS_MAX_BYTES || typeof c.capped !== 'boolean' || !Number.isFinite(c.expires)) return 'unavailable';
          if (c.expires < t) counters.delete(sid);
        }
        // Keep overlapping sessions separate until each is older than the SDK's four-hour maximum.
        const counter = { ...(counters.get(session) ?? { bytes: 0, capped: false, expires: t + 14_400_000 }) };
        used = counter.bytes;
        if (counter.capped || bytes > CANVAS_MAX_BYTES - used) counter.capped = true;
        else counter.bytes += bytes;
        if (!active()) return 'unavailable';
        counters.set(session, counter);
        if (store) window[store].setItem(CANVAS_BUDGET_KEY, JSON.stringify([...counters]));
        used = counter.bytes;
        return counter.capped ? 'cap' : 'ok';
      } catch {
        return 'unavailable';
      }
    };
    if (!available) return Promise.resolve('unavailable');
    return store === 'localStorage'
      ? navigator.locks.request(CANVAS_BUDGET_KEY, take).catch(() => 'unavailable' as const)
      : Promise.resolve(take());
  };
  return { reserve, available, get used() { return used; } };
}
