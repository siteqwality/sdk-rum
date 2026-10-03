const KEY_PREFIX = 'sq_rum_replay_next:';

/** Random start in the upper half of the u32 range, clear of stored counters. */
export function fallbackBase(): number {
  return 2 ** 31 + Math.floor(Math.random() * 2 ** 30);
}

function readNext(sessionId: string): number {
  try {
    const value = Number(sessionStorage.getItem(KEY_PREFIX + sessionId));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeNext(sessionId: string, next: number): boolean {
  try {
    sessionStorage.setItem(KEY_PREFIX + sessionId, String(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * Segment indexes that never repeat within a session, kept in sessionStorage
 * so a reload carries on numbering instead of overwriting earlier pages.
 */
export class SegmentSequence {
  private next = 0;
  private stored = true;

  constructor(private sessionId: string) {}

  take(): number {
    if (this.stored) {
      // Another page of the session (reload, back-forward cache) may have moved on.
      this.next = Math.max(this.next, readNext(this.sessionId));
      // Reserved before use, so no later page load can reuse it.
      if (writeNext(this.sessionId, this.next + 1)) return this.next++;
      this.stored = false;
      this.next = fallbackBase();
    }
    return this.next++;
  }
}
