// A hard ceiling on the SDK's own requests and bytes, per page load and per session, whatever the
// cause (a bug, a retry storm, hidden tabs). Requests are billed even when the intake drops them.
import { storage } from './util';

/** A 4 h session at full activity with replay makes about 2,200 requests and 160 MB at most. */
export const PAGE_MAX_REQUESTS = 4_000;
export const PAGE_MAX_BYTES = 250_000_000;
export const SESSION_MAX_REQUESTS = 10_000;
export const SESSION_MAX_BYTES = 500_000_000;
const KEY = '_sq_bgt';

export type Budget = ReturnType<typeof createBudget>;

/** `kind` says where session counters live, as the session itself: shared, this tab, or memory. */
export function createBudget(kind: () => 'localStorage' | 'sessionStorage' | undefined) {
  let sid = '';
  let page = [0, 0];
  let sess = [0, 0];

  function reset(id: string): void {
    sid = id;
    page = [0, 0];
    const where = kind();
    const [s, r, b] = ((where && storage.get(where, KEY)) || '').split('|');
    sess = s === id ? [Number(r) || 0, Number(b) || 0] : [0, 0];
  }

  return {
    /** Counts one request of `bytes`; false, and nothing counted, past any ceiling. */
    take(id: string, bytes: number): boolean {
      if (id !== sid) reset(id);
      if (page[0] >= PAGE_MAX_REQUESTS || sess[0] >= SESSION_MAX_REQUESTS || page[1] + bytes > PAGE_MAX_BYTES || sess[1] + bytes > SESSION_MAX_BYTES) {
        return false;
      }
      page = [page[0] + 1, page[1] + bytes];
      sess = [sess[0] + 1, sess[1] + bytes];
      const where = kind();
      if (where) storage.set(where, KEY, `${id}|${sess[0]}|${sess[1]}`);
      return true;
    },
  };
}
