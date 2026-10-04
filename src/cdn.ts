import { SiteQwalityRUM } from './init';
import { PUBLIC_METHODS } from './api';

// CDN entry, a classic IIFE whose only global is window.SiteQwalityRUM. It replaces
// the snippet stub and replays its queue: init first, then the rest in order.

type QueueEntry = [string, ArrayLike<unknown>];

interface Stub {
  __sq?: unknown;
  _q?: QueueEntry[];
  _h?: EventListener;
  [method: string]: unknown;
}

const win = window as unknown as { SiteQwalityRUM?: Stub };

function boot(): void {
  const stub = win.SiteQwalityRUM;
  // A second copy of this script leaves the first in place.
  if (stub && stub.__sq === true) return;

  const queue = stub && Array.isArray(stub._q) ? stub._q : [];
  if (stub && typeof stub._h === 'function') {
    window.removeEventListener('error', stub._h);
    window.removeEventListener('unhandledrejection', stub._h);
  }

  win.SiteQwalityRUM = SiteQwalityRUM as unknown as Stub;

  const api = SiteQwalityRUM as unknown as Record<string, (...args: unknown[]) => unknown>;
  const run = (entry: QueueEntry) => {
    try {
      const [method, args] = entry;
      const list = Array.prototype.slice.call(args ?? []);
      if (method === '_e') {
        SiteQwalityRUM._captureEarly(list[0]);
      } else if ((PUBLIC_METHODS as readonly string[]).includes(method)) {
        void api[method](...list);
      }
    } catch {
      // One bad entry must not stop the rest.
    }
  };
  for (const entry of queue) if (isEntry(entry) && entry[0] === 'init') run(entry);
  for (const entry of queue) if (isEntry(entry) && entry[0] !== 'init') run(entry);
  // No init yet (deferred, or bad options): keep catching page errors until it runs.
  SiteQwalityRUM._holdEarly();

  // Code that kept a reference to the stub still reaches the SDK.
  if (stub && typeof stub === 'object') {
    for (const method of PUBLIC_METHODS) {
      stub[method] = (...args: unknown[]) => api[method](...args);
    }
  }
}

function isEntry(entry: unknown): entry is QueueEntry {
  return Array.isArray(entry) && typeof entry[0] === 'string';
}

try {
  boot();
} catch {
  // Monitoring must never break the host page.
}
