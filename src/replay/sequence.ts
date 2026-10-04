// Segment indexes that never repeat within a session: one counter for all the session's tabs
// (only one records at a time), carried across reloads.
import { storage } from '../core/util';
import { storageKv, type Kv } from './lease';

const KEY = '_sq_rseq';
const LEGACY = 'sq_rum_replay_next:';

/** Shared by the session's tabs, this tab only (cookieless), memory (nothing stored), or a store. */
export type SeqStore = 'localStorage' | 'sessionStorage' | 'memory' | Kv;

/** Random start in the upper half of the u32 range, clear of stored counters. */
export function fallbackBase(): number {
  return 2 ** 31 + Math.floor(Math.random() * 2 ** 30);
}

const count = (v: string | null | undefined) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

const kvOf = (where: SeqStore): Kv | null => (typeof where === 'object' ? where : where === 'memory' ? null : storageKv(where));

/** The last few sessions' counters, `sid:next` newest first and `~` apart, in one key. */
const entries = (kv: Kv | null) => ((kv && kv.get(KEY)) || '').split('~').map((e) => e.split(':'));

function readNext(sessionId: string, kv: Kv | null): number {
  const mine = entries(kv).find(([s]) => s === sessionId);
  // A 1.1 page of this session numbered in this tab's sessionStorage.
  return Math.max(count(mine?.[1]), count(storage.get('sessionStorage', LEGACY + sessionId)));
}

/** Whether an earlier page of this session in this tab already recorded replay. */
export function hasRecorded(sessionId: string, where: SeqStore = 'sessionStorage'): boolean {
  return readNext(sessionId, kvOf(where)) > 0;
}

export class SegmentSequence {
  private next = 0;
  private kv: Kv | null;
  private stored: boolean;

  constructor(
    private sessionId: string,
    where: SeqStore = 'sessionStorage',
  ) {
    this.kv = kvOf(where);
    this.stored = !!this.kv;
  }

  take(): number {
    if (this.stored) {
      const kv = this.kv!;
      const stored = readNext(this.sessionId, kv);
      // The counter vanished under us (consent withdrawn in another tab): never reuse an index.
      if (!stored && this.next) this.stored = false;
      else {
        this.next = Math.max(this.next, stored);
        // Reserved before use, so no later page load can reuse it.
        const rest = entries(kv).filter(([s]) => s && s !== this.sessionId).slice(0, 3);
        if (kv.set(KEY, [`${this.sessionId}:${this.next + 1}`, ...rest.map((e) => e.join(':'))].join('~'))) return this.next++;
        this.stored = false;
      }
      const first = this.next === 0;
      this.next = fallbackBase();
      // A session that never stored an index still starts at 0.
      if (first) return 0;
    }
    return this.next++;
  }
}
