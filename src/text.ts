/** Cuts to at most `max` UTF-16 units without leaving half a surrogate pair. */
export function cut(text: string, max: number): string {
  const out = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}
