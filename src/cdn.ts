import { SiteQwalityRUM } from './init';

// Process queued calls from the async CDN snippet
const win = window as unknown as {
  SiteQwalityRUM: typeof SiteQwalityRUM & { _q?: [string, unknown[]][] };
};

const queued = win.SiteQwalityRUM?._q || [];

// Replace the stub with the real SDK
win.SiteQwalityRUM = SiteQwalityRUM;

// Replay queued method calls
for (const [method, args] of queued) {
  const fn = (SiteQwalityRUM as unknown as Record<string, Function>)[method];
  if (typeof fn === 'function') {
    fn(...args);
  }
}
