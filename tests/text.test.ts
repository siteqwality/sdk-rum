import { describe, it, expect } from 'vitest';
import { cut } from '../src/text';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cut', () => {
  it('keeps short text and cuts long text at the cap', () => {
    expect(cut('abc', 5)).toBe('abc');
    expect(cut('abcdef', 3)).toBe('abc');
  });

  it('drops half an emoji at the cap', () => {
    const out = cut(`${'a'.repeat(4)}😀`, 5);
    expect(out).toBe('aaaa');
    expect(LONE_SURROGATE.test(out)).toBe(false);
  });

  it('keeps a whole emoji that fits', () => {
    expect(cut('a😀b', 3)).toBe('a😀');
  });
});
