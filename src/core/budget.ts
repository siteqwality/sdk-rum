// A hard ceiling on the SDK's own requests and bytes, per page load and per session, whatever the
// cause (a bug, a retry storm, hidden tabs). Requests are billed even when the intake drops them.
import { storage } from './util';

/** A 4 h session at full activity with replay makes about 2,200 requests and 160 MB at most. */
export const SESSION_MAX_REQUESTS = 5_000;
export const SESSION_MAX_BYTES = 250_000_000;
/** Holds across the sessions of one document, for a tab that is never reloaded. */
export const PAGE_MAX_REQUESTS = 10_000;
export const PAGE_MAX_BYTES = 500_000_000;
const KEY = '_sq_bgt';

export type Budget = ReturnType<typeof createBudget>;

/** `kind` says where session counters live, as the session itself: shared, this tab, or memory. */
export function createBudget(kind: () => 'localStorage' | 'sessionStorage' | undefined) {
  let page = [0, 0];
  let sid = '';
  let mine = [0, 0];
  const pageOpen = (bytes = 0) => page[0] < PAGE_MAX_REQUESTS && page[1] + bytes <= PAGE_MAX_BYTES;

  return {
    pageOpen: () => pageOpen(),
    /** Counts one request of `bytes`; false, and nothing counted, past any ceiling. */
    take(id: string, bytes: number): boolean {
      if (id !== sid) [sid, mine] = [id, [0, 0]];
      const where = kind();
      // Tabs sharing the session add to one stored count; our own count covers failed writes.
      const [s, r, b] = ((where && storage.get(where, KEY)) || '').split('|');
      const sess = s === id ? [Math.max(Number(r) || 0, mine[0]), Math.max(Number(b) || 0, mine[1])] : mine;
      if (!pageOpen(bytes) || sess[0] >= SESSION_MAX_REQUESTS || sess[1] + bytes > SESSION_MAX_BYTES) return false;
      page = [page[0] + 1, page[1] + bytes];
      mine = [sess[0] + 1, sess[1] + bytes];
      if (where) storage.set(where, KEY, `${id}|${mine[0]}|${mine[1]}`);
      return true;
    },
  };
}
