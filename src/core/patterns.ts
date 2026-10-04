// Port of core-rs `common::rum::patterns` (TextPatterns): a case-sensitive substring, or a regular
// expression written `/…/` (`/…/i` ignores case). Blank, over-long and invalid patterns are skipped.
import { read } from './util';

export const MAX_PATTERNS = 50;
export const MAX_PATTERN_CHARS = 256;

export type TextMatcher = (text: string) => boolean;

/** `slashes` false keeps strings as substrings (the init options), and takes RegExp values. */
export function textPatterns(list: unknown, slashes = true): TextMatcher {
  const subs: string[] = [];
  const res: RegExp[] = [];
  for (const p of Array.isArray(list) ? list.slice(0, slashes ? MAX_PATTERNS : undefined) : []) {
    if (p instanceof RegExp) res.push(p);
    else if (typeof p === 'string' && p.trim() && (!slashes || [...p].length <= MAX_PATTERN_CHARS)) {
      const m = slashes ? /^\/([\s\S]+)\/(i?)$/.exec(p) : null;
      if (!m) subs.push(p);
      else
        try {
          res.push(new RegExp(m[1], m[2]));
        } catch {
          // Skipped, as core-rs skips an expression that does not compile.
        }
    }
  }
  // Expressions skip text over 4 KB (JS regexes backtrack; core-rs runs in linear time), so the
  // SDK never drops what the intake would keep.
  return (t) =>
    subs.some((s) => t.includes(s)) ||
    (t.length <= 4096 && res.some((r) => read(() => ((r.lastIndex = 0), r.test(t))) === true));
}
