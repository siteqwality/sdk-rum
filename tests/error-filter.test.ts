import { describe, it, expect } from 'vitest';
import cases from './fixtures/error-noise-cases.json';
import extraCases from './fixtures/error-noise-extra-cases.json';
import {
  isBrowserNoise,
  normalizeErrorMessage,
  frameSchemes,
  createIgnoreErrorsMatcher,
  ErrorRateLimiter,
  rateLimitKey,
  EXTENSION_SCHEMES,
} from '../src/errors/filter';

interface NoiseCase {
  name: string;
  message: string;
  stack: string;
  filename: string;
  ignore: boolean;
}

// Shared byte for byte with core-rs common/src/rum/testdata; both suites run every case.
describe('browser noise (shared fixture)', () => {
  it('has at least 20 cases with unique names', () => {
    const list = cases as NoiseCase[];
    expect(list.length).toBeGreaterThanOrEqual(20);
    expect(new Set(list.map((c) => c.name)).size).toBe(list.length);
    expect(list.some((c) => c.ignore)).toBe(true);
    expect(list.some((c) => !c.ignore)).toBe(true);
  });

  for (const c of cases as NoiseCase[]) {
    it(`${c.name} -> ${c.ignore ? 'ignored' : 'kept'}`, () => {
      expect(isBrowserNoise(c.message, c.stack, c.filename)).toBe(c.ignore);
    });
  }
});

// More cases, run by this suite only.
describe('browser noise (SDK cases)', () => {
  for (const c of extraCases as NoiseCase[]) {
    it(`${c.name} -> ${c.ignore ? 'ignored' : 'kept'}`, () => {
      expect(isBrowserNoise(c.message, c.stack, c.filename)).toBe(c.ignore);
    });
  }
});

describe('browser noise, SDK only', () => {
  // The ingestor never sees ErrorEvent.filename, so these stay out of the shared fixture.
  it('drops a frameless error whose script is an extension', () => {
    expect(
      isBrowserNoise('TypeError: Failed to fetch', '', 'chrome-extension://abc/content.js'),
    ).toBe(true);
    expect(isBrowserNoise('Error', '', 'moz-extension://abc/content.js')).toBe(true);
  });

  it('keeps a frameless error from a page script or with no filename', () => {
    expect(isBrowserNoise('TypeError: Failed to fetch', '', 'https://shop.example.com/app.js')).toBe(false);
    expect(isBrowserNoise('TypeError: Failed to fetch', '')).toBe(false);
  });

  it('treats every listed scheme as an extension', () => {
    for (const scheme of EXTENSION_SCHEMES) {
      expect(isBrowserNoise('Error: x', `    at ${scheme}://id/a.js:1:1`)).toBe(true);
    }
  });
});

describe('normalizeErrorMessage', () => {
  it('trims, then strips one leading "Uncaught "', () => {
    expect(normalizeErrorMessage('  Uncaught TypeError: x  ')).toBe('TypeError: x');
    expect(normalizeErrorMessage('Uncaught Uncaught x')).toBe('Uncaught x');
    expect(normalizeErrorMessage('Uncaught')).toBe('Uncaught');
    expect(normalizeErrorMessage('TypeError: x')).toBe('TypeError: x');
  });
});

describe('frameSchemes', () => {
  it('finds V8 and Gecko frame URLs', () => {
    expect(
      frameSchemes('at f (https://a.example/x.js:1:2)\ng@chrome-extension://id/y.js:3:4'),
    ).toEqual(['https', 'chrome-extension']);
    expect(frameSchemes('at <anonymous>')).toEqual([]);
  });
});

describe('createIgnoreErrorsMatcher', () => {
  it('matches a string as a case-sensitive substring', () => {
    const match = createIgnoreErrorsMatcher(['Network request failed']);
    expect(match('TypeError: Network request failed (abort)')).toBe(true);
    expect(match('TypeError: network request failed')).toBe(false);
  });

  it('tests a RegExp, including a global one, the same way every time', () => {
    const match = createIgnoreErrorsMatcher([/^chunk \d+ failed/gi]);
    expect(match('Chunk 12 failed to load')).toBe(true);
    expect(match('Chunk 12 failed to load')).toBe(true);
    expect(match('Loading chunk 12 failed')).toBe(false);
  });

  it('skips empty strings and anything that is not a string or RegExp', () => {
    const match = createIgnoreErrorsMatcher(['', 7, null, {}, undefined]);
    expect(match('anything')).toBe(false);
    expect(createIgnoreErrorsMatcher(undefined)('x')).toBe(false);
    expect(createIgnoreErrorsMatcher('not a list')('not a list')).toBe(false);
  });
});

describe('ErrorRateLimiter', () => {
  it('allows a burst of 10, then 1 per 10 s', () => {
    const limiter = new ErrorRateLimiter();
    const t0 = 1_000_000;
    const allowed = Array.from({ length: 30 }, () => limiter.allow('k', t0)).filter(Boolean);
    expect(allowed).toHaveLength(10);
    expect(limiter.allow('k', t0 + 9_999)).toBe(false);
    expect(limiter.allow('k', t0 + 10_000)).toBe(true);
    expect(limiter.allow('k', t0 + 10_001)).toBe(false);
  });

  it('keeps a bucket per key and refills up to 10 only', () => {
    const limiter = new ErrorRateLimiter();
    for (let i = 0; i < 10; i++) limiter.allow('a', 0);
    expect(limiter.allow('a', 0)).toBe(false);
    expect(limiter.allow('b', 0)).toBe(true);
    const later = 10 * 60_000;
    const allowed = Array.from({ length: 20 }, () => limiter.allow('a', later)).filter(Boolean);
    expect(allowed).toHaveLength(10);
  });

  it('keys on the normalized message, cut to 200 characters', () => {
    expect(rateLimitKey('Uncaught TypeError: x')).toBe('TypeError: x');
    expect(rateLimitKey(`  ${'m'.repeat(300)}`)).toBe('m'.repeat(200));
  });
});
