import { describe, it, expect, vi } from 'vitest';
import * as util from '../src/core/util';
import { fnv1a64, CssStore, CSS_REF } from '../src/replay/css';

describe('fnv1a64', () => {
  // Published FNV-1a 64 vectors (isthe.com/chongo/tech/comp/fnv), shared with the compactor.
  it.each([
    ['', 'cbf29ce484222325'],
    ['a', 'af63dc4c8601ec8c'],
    ['foobar', '85944171f73967e8'],
  ])('hashes %j to %s', (text, hex) => {
    expect(fnv1a64(text)).toBe(hex);
  });

  it('hashes the UTF-8 bytes, as a BigInt reference does', () => {
    const reference = (text: string) => {
      let h = 0xcbf29ce484222325n;
      for (const b of Buffer.from(text, 'utf8')) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
      return h.toString(16).padStart(16, '0');
    };
    for (const text of ['a{content:"é"}', '.icon::before{content:"\u{1F600}"}', 'p{font-family:"ヒラギノ"}', '\u0000￿']) {
      expect(fnv1a64(text)).toBe(reference(text));
    }
  });

  it('hashes a megabyte in well under a frame on this machine', () => {
    const css = '.c{color:red}'.repeat(80_000);
    const t = performance.now();
    fnv1a64(css);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe('CssStore', () => {
  const big = 'x{y:z}'.repeat(400);

  it('names only stylesheets the intake acknowledged', () => {
    const css = new CssStore();
    expect(css.ref(big)).toBeNull();
    css.ack([big]);
    expect(css.ref(big)).toBe(CSS_REF + fnv1a64(big));
  });

  it('hashes each stylesheet once, however many checkouts name it', () => {
    const css = new CssStore();
    css.ack([big]);
    const spy = vi.spyOn(util, 'utf8');
    css.ref(big);
    css.ref(`${big}`);
    css.ref(big.slice(0));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('forgets everything when cleared, so the next snapshot inlines again', () => {
    const css = new CssStore();
    css.ack([big]);
    css.clear();
    expect(css.ref(big)).toBeNull();
    expect(css.size).toBe(0);
  });
});
