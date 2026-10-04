// One tab records a shared session at a time (2.0.0, until per-window segments in 2.1).

/** The tab recording a shared session: `sid|window|heartbeat`, kept fresh while it owns it. */
export const LEASE_KEY = '_sq_rl';
export const LEASE_TTL_MS = 45_000;
/** Lease heartbeat and idle check. */
export const BEAT_MS = 15_000;
/** A takeover waits this long, so the tab it takes over from stops first. */
export const TAKEOVER_MS = 250;
