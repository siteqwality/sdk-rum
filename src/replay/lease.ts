// One tab records a shared session at a time (2.0.0, until per-window segments in 2.1). The lease
// and the segment counter live where the session's tabs can all see them.
import { storage, read } from '../core/util';

/** The tab recording each live session: `sid|window|beat` entries joined by `~`. */
export const LEASE_KEY = '_sq_rl';
export const LEASE_TTL_MS = 45_000;
/** Lease heartbeat and idle check. */
export const BEAT_MS = 15_000;
/** An owner rewrites its lease at most this often. */
export const WRITE_MS = 5_000;
/** A takeover waits this long, so the tab it takes over from stops first. */
export const TAKEOVER_MS = 250;
/** Cookies fire no storage events: tabs on other subdomains read the lease this often. */
export const POLL_MS = 500;

export interface Kv {
  get(key: string): string | null;
  /** An empty value removes the key. */
  set(key: string, value: string): boolean;
}

export const storageKv = (kind: 'localStorage' | 'sessionStorage'): Kv => ({
  get: (k) => storage.get(kind, k),
  set: (k, v) => (v ? storage.set(kind, k, v) : (storage.del(kind, k), true)),
});

/** A cookie on `domain`, for a session shared across its subdomains (`cookieDomain`). */
export const cookieKv = (domain: string): Kv => ({
  get: (k) => read(() => new RegExp(`(?:^|;\\s*)${k}=([^;]*)`).exec(document.cookie)?.[1]) ?? null,
  set: (k, v) =>
    read(() => {
      document.cookie = `${k}=${v};path=/;max-age=${v ? 14_400 : 0};SameSite=Lax;domain=${domain}${location.protocol === 'https:' ? ';Secure' : ''}`;
      return true;
    }) === true,
});
