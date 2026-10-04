// cut and the v4 ids, restored from 1.x.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cut } from '../src/core/util';
import { uuid, fnv1a32 } from '../src/core/hash';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

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

describe('uuid', () => {
  it('is a v4 UUID', () => {
    expect(uuid()).toMatch(V4);
  });

  it('builds a v4 UUID from getRandomValues on plain http pages', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(0xff) });
    expect(uuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('still returns a v4 UUID with no crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    const ids = new Set(Array.from({ length: 50 }, () => uuid()));
    for (const id of ids) expect(id).toMatch(V4);
    expect(ids.size).toBe(50);
  });
});

describe('fnv1a32', () => {
  it('hashes a lone surrogate as U+FFFD, as the Rust side sees it', () => {
    expect(fnv1a32('a\ud800b')).toBe(fnv1a32('a\ufffdb'));
  });
});
