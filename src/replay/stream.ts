// One page load's recording in one session (design 6.4): `s`, `w`, `p`, a sequence from 0 and
// the stylesheets the intake acknowledged. Kept for the page, so a restarted recorder continues.
import { CssStore } from './css';

export interface Stream {
  s: string;
  w: string;
  p: string;
  /** Next sequence number (u32), per page load from 0. */
  q: number;
  css: CssStore;
}

const streams = new Map<string, Stream>();

export function streamFor(s: string, w: string, p: string): Stream {
  const key = `${s}|${p}`;
  let st = streams.get(key);
  if (!st) {
    streams.set(key, (st = { s, w, p, q: 0, css: new CssStore() }));
    // A page load meets few sessions; forget the oldest.
    if (streams.size > 8) streams.delete(streams.keys().next().value!);
  }
  return st;
}
