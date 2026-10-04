// Segment indexes that never repeat within a session: one counter for all the session's tabs
// (only one records at a time), carried across reloads.
import { storage } from '../core/util';

const KEY = '_sq_rseq';
const LEGACY = 'sq_rum_replay_next:';

/** Shared by the session's tabs, this tab only (cookieless), or memory (nothing stored). */
export type SeqStore = 'localStorage' | 'sessionStorage' | 'memory';

/** Random start in the upper half of the u32 range, clear of stored counters. */
export function fallbackBase(): number {
  return 2 ** 31 + Math.floor(Math.random() * 2 ** 30);
}

const count = (v: string | null | undefined) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** The last few sessions' counters, `sid:next` newest first, in one key. */
const entries = (where: SeqStore) => ((where !== 'memory' && storage.get(where, KEY)) || '').split(';').map((e) => e.split(':'));

function readNext(sessionId: string, where: SeqStore): number {
  const mine = entries(where).find(([s]) => s === sessionId);
  // A 1.1 page of this session numbered in this tab's sessionStorage.
  return Math.max(count(mine?.[1]), count(storage.get('sessionStorage', LEGACY + sessionId)));
}

function writeNext(sessionId: string, where: SeqStore, next: number): boolean {
  const rest = entries(where).filter(([s]) => s && s !== sessionId).slice(0, 3);
  return where !== 'memory' && storage.set(where, KEY, [`${sessionId}:${next}`, ...rest.map((e) => e.join(':'))].join(';'));
}

/** Whether an earlier page of this session in this tab already recorded replay. */
export function hasRecorded(sessionId: string, where: SeqStore = 'sessionStorage'): boolean {
  return readNext(sessionId, where) > 0;
}

export class SegmentSequence {
  private next = 0;
  private stored: boolean;

  constructor(
    private sessionId: string,
    private where: SeqStore = 'sessionStorage',
  ) {
    this.stored = where !== 'memory';
  }

  take(): number {
    if (this.stored) {
      // Another page or tab of the session may have moved on.
      this.next = Math.max(this.next, readNext(this.sessionId, this.where));
      // Reserved before use, so no later page load can reuse it.
      if (writeNext(this.sessionId, this.where, this.next + 1)) return this.next++;
      this.stored = false;
      const first = this.next === 0;
      this.next = fallbackBase();
      // A session that never stored an index still starts at 0.
      if (first) return 0;
    }
    return this.next++;
  }
}
