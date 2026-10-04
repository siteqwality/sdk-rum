// CSS references (design 5.5): a checkout names a stylesheet the intake already holds
// instead of sending it again. The player and compactor resolve `sq-css:<hash>`.
import { utf8 } from '../core/util';

/** Stylesheets shorter than this always stay inline. */
export const CSS_REF_MIN = 1024;
export const CSS_REF = 'sq-css:';

/** FNV-1a 64 over UTF-8, as 16 lowercase hex digits (shared with the compactor). */
export function fnv1a64(text: string): string {
  // 16-bit limbs, low first; the prime is 2^40 + 0x1b3.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (const b of utf8(text)) {
    h0 ^= b;
    const t0 = h0 * 0x1b3;
    let t1 = h1 * 0x1b3;
    let t2 = h2 * 0x1b3 + (h0 << 8);
    const t3 = h3 * 0x1b3 + (h1 << 8);
    t1 += t0 >>> 16;
    h0 = t0 & 0xffff;
    t2 += t1 >>> 16;
    h1 = t1 & 0xffff;
    h3 = (t3 + (t2 >>> 16)) & 0xffff;
    h2 = t2 & 0xffff;
  }
  return [h3, h2, h1, h0].map((x) => x.toString(16).padStart(4, '0')).join('');
}

/**
 * Stylesheets the intake acknowledged for one page load's stream, by text, with their hash
 * once computed. Only acknowledged copies are referenced, so a lost segment never orphans one.
 */
export class CssStore {
  private acked = new Map<string, string>();

  /** The intake holds these texts. */
  ack(texts: string[]): void {
    for (const t of texts) if (!this.acked.has(t)) this.acked.set(t, '');
  }

  /** A reference for `text`, or null when it must go inline. Hashes each text once. */
  ref(text: string): string | null {
    const h = this.acked.get(text);
    if (h === undefined) return null;
    if (h) return CSS_REF + h;
    const fresh = fnv1a64(text);
    this.acked.set(text, fresh);
    return CSS_REF + fresh;
  }

  /** Forget everything, so the next snapshot inlines again (a snapshot segment was lost). */
  clear(): void {
    this.acked.clear();
  }

  get size(): number {
    return this.acked.size;
  }
}
