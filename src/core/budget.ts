// A hard ceiling on the SDK's own requests and bytes, per page load and per session, whatever the
// cause (a bug, a retry storm, hidden tabs). Requests are billed even when the intake drops them.
import { storage } from './util';

/** Page requests, page bytes, session requests, session bytes. */
export type Limits = readonly [number, number, number, number];

/** Batches, config, identity: a 4 h session at full activity makes about 1,500 requests. */
export const CORE_LIMITS: Limits = [10_000, 200e6, 5_000, 100e6];
/** Replay segments, apart so a replay cap never stops errors or views (about 600 in 4 h). */
export const REPLAY_LIMITS: Limits = [5_000, 500e6, 2_500, 250e6];
export const CORE_KEY = '_sq_bgt';
export const REPLAY_KEY = '_sq_bgr';
/** The name of the error a refused request rejects with. */
export const BUDGET = 'SqBudget';

export const budgetError = (): Error => Object.assign(new Error('request budget'), { name: BUDGET });

export type Budget = ReturnType<typeof createBudget>;

/**
 * `kind` says where session counters live, as the session itself: shared, this tab, or memory.
 * The page ceiling holds across the sessions of one document, for a tab that is never reloaded.
 */
export function createBudget(kind: () => 'localStorage' | 'sessionStorage' | undefined, key: string, [pageReq, pageBytes, sessReq, sessBytes]: Limits) {
  let page = [0, 0];
  let sid = '';
  let mine = [0, 0];
  const pageOpen = (bytes = 0) => page[0] < pageReq && page[1] + bytes <= pageBytes;

  return {
    pageOpen: () => pageOpen(),
    /** Counts one request of `bytes`; false, and nothing counted, past any ceiling. */
    take(id: string, bytes: number): boolean {
      if (id !== sid) [sid, mine] = [id, [0, 0]];
      const where = kind();
      // Tabs sharing the session add to one stored count; our own count covers failed writes.
      const [s, r, b] = ((where && storage.get(where, key)) || '').split('|');
      const sess = s === id ? [Math.max(Number(r) || 0, mine[0]), Math.max(Number(b) || 0, mine[1])] : mine;
      if (!pageOpen(bytes) || sess[0] >= sessReq || sess[1] + bytes > sessBytes) return false;
      page = [page[0] + 1, page[1] + bytes];
      mine = [sess[0] + 1, sess[1] + bytes];
      if (where) storage.set(where, key, `${id}|${mine[0]}|${mine[1]}`);
      return true;
    },
  };
}
