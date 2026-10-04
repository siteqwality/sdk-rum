// Mirrors the core-rs `common::rum::patterns` tests, so both sides read a pattern list alike.
import { describe, it, expect } from 'vitest';
import { textPatterns, MAX_PATTERN_CHARS, MAX_PATTERNS } from '../src/core/patterns';

describe('textPatterns', () => {
  it('substrings are case sensitive and regexes need slashes', () => {
    const p = textPatterns(['ChunkLoadError', '/^Network(Error)?$/', '/timeout/i', '/', '//', '  ']);
    expect(p('Loading ChunkLoadError: chunk 7')).toBe(true);
    expect(p('chunkloaderror')).toBe(false);
    expect(p('NetworkError')).toBe(true);
    expect(p('A NetworkError')).toBe(false);
    expect(p('request TIMEOUT')).toBe(true);
    // "/" and "//" hold no expression, so they stay substrings.
    expect(p('https://x')).toBe(true);
    expect(textPatterns(['//'])('a/b')).toBe(false);
    expect(textPatterns([])('anything')).toBe(false);
  });

  it('a bad regex is skipped without disabling the others', () => {
    const p = textPatterns(['/(unclosed/', '/ok/']);
    expect(p('ok')).toBe(true);
    expect(p('(unclosed')).toBe(false);
  });

  it('over-long patterns and those past the list cap are skipped', () => {
    expect(textPatterns(['x'.repeat(MAX_PATTERN_CHARS + 1)])('x'.repeat(300))).toBe(false);
    const list = [...Array.from({ length: MAX_PATTERNS }, (_, i) => `p${i}-`), 'late'];
    expect(textPatterns(list)('late')).toBe(false);
  });

  it('matches anywhere in a URL, as never_record_urls and body_urls mean', () => {
    const p = textPatterns(['checkout', '/\\/account\\/\\d+/']);
    expect(p('https://shop.test/fr/checkout/payment')).toBe(true);
    expect(p('https://shop.test/account/42/settings')).toBe(true);
    expect(p('https://shop.test/account/me')).toBe(false);
  });

  it('expressions skip text over 4 KB, so the SDK never drops what the intake keeps; substrings see it all', () => {
    const text = `needle${'a'.repeat(5000)}`;
    expect(textPatterns(['/^needle/'])(text)).toBe(false);
    expect(textPatterns(['/a$/'])('a'.repeat(4096))).toBe(true);
    expect(textPatterns(['needle'])(text)).toBe(true);
  });

  it('init options keep strings as substrings and take RegExp values', () => {
    const p = textPatterns(['/literal/', /Re+gex/], false);
    expect(p('a /literal/ path')).toBe(true);
    expect(p('literal')).toBe(false);
    expect(p('Reeegex')).toBe(true);
  });
});
