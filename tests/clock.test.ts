import { describe, it, expect, vi, afterEach } from 'vitest';
import { now, epochOf, CLOCK_SANITY_MS } from '../src/core/util';
import { uuid7 } from '../src/core/hash';

const mono = () => performance.timeOrigin + performance.now();

afterEach(() => vi.restoreAllMocks());

describe('now', () => {
  it('is Date.now while Date agrees with the monotonic clock', () => {
    expect(Math.abs(now() - Date.now())).toBeLessThan(5);
  });

  it('ignores a page that patched Date into another year', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2000, 9, 4));
    expect(Math.abs(now() - mono())).toBeLessThan(5);
  });

  it('trusts Date ahead of the monotonic clock by sleep drift, within the bound', () => {
    const drift = 8 * 60 * 60_000;
    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real + drift);
    expect(now()).toBe(real + drift);
    vi.spyOn(Date, 'now').mockReturnValue(real + CLOCK_SANITY_MS + 60_000);
    expect(Math.abs(now() - mono())).toBeLessThan(5);
  });

  it('holds small steps back, so times never run backwards; follows a large reset', () => {
    const base = Date.now() + 10_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(base);
    expect(now()).toBe(base);
    spy.mockReturnValue(base - 500);
    expect(now()).toBe(base);
    spy.mockReturnValue(base - 60_000);
    expect(now()).toBe(base - 60_000);
  });

  it('puts performance timestamps on the same clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2000, 9, 4));
    const p = performance.now() - 250;
    expect(Math.abs(epochOf(p) - (mono() - 250))).toBeLessThan(5);
  });
});

describe('uuid7', () => {
  it('carries the SDK clock in its first 48 bits, whatever Date says', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2000, 9, 4));
    const ms = parseInt(uuid7().replace(/-/g, '').slice(0, 12), 16);
    expect(Math.abs(ms - mono())).toBeLessThan(5);
  });
});
