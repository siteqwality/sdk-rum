import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SegmentSequence } from '../src/replay/sequence';

const U32_MAX = 2 ** 32 - 1;

function take(sequence: SegmentSequence, n: number): number[] {
  return Array.from({ length: n }, () => sequence.take());
}

describe('SegmentSequence', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('continues numbering across reloads of the same session', () => {
    // Each page load builds a new sequence over the same tab storage.
    expect(take(new SegmentSequence('s1'), 3)).toEqual([0, 1, 2]);
    expect(take(new SegmentSequence('s1'), 2)).toEqual([3, 4]);
    expect(take(new SegmentSequence('s1'), 1)).toEqual([5]);
  });

  it('starts every session at 0', () => {
    expect(take(new SegmentSequence('s1'), 2)).toEqual([0, 1]);
    expect(take(new SegmentSequence('s2'), 2)).toEqual([0, 1]);
    expect(take(new SegmentSequence('s1'), 1)).toEqual([2]);
  });

  it('skips past indexes another page of the session took', () => {
    // A page restored from the back-forward cache, and the page that ran meanwhile.
    const restored = new SegmentSequence('s1');
    expect(restored.take()).toBe(0);
    expect(take(new SegmentSequence('s1'), 2)).toEqual([1, 2]);
    expect(restored.take()).toBe(3);
  });

  it('reserves an index before handing it out', () => {
    new SegmentSequence('s1').take();
    expect(take(new SegmentSequence('s1'), 1)).toEqual([1]);
  });

  it('starts at 0, then numbers from a random base, when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const random = vi.spyOn(Math, 'random');

    random.mockReturnValueOnce(0.25);
    const first = take(new SegmentSequence('s1'), 3);
    random.mockReturnValueOnce(0.75);
    const second = take(new SegmentSequence('s1'), 3);

    const a = 2 ** 31 + 2 ** 28;
    const b = 2 ** 31 + 3 * 2 ** 28;
    expect(first).toEqual([0, a, a + 1]);
    expect(second).toEqual([0, b, b + 1]);
    for (const index of [...first.slice(1), ...second.slice(1)]) {
      expect(index).toBeGreaterThanOrEqual(2 ** 31);
      expect(index).toBeLessThanOrEqual(U32_MAX);
    }
  });

  it('skips 0 when a stored index shows the session already has one', () => {
    sessionStorage.setItem('sq_rum_replay_next:s1', '4');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const indexes = take(new SegmentSequence('s1'), 2);
    expect(indexes[0]).toBeGreaterThanOrEqual(2 ** 31);
    expect(indexes[1]).toBe(indexes[0] + 1);
  });

  it('falls back when storage cannot be read either', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const indexes = take(new SegmentSequence('s1'), 3);
    expect(indexes[0]).toBe(0);
    expect(indexes[1]).toBeGreaterThanOrEqual(2 ** 31);
    expect(indexes[2]).toBe(indexes[1] + 1);
  });

  it('keeps the fallback once storage has failed', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const sequence = new SegmentSequence('s1');
    expect(sequence.take()).toBe(0);

    setItem.mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const base = sequence.take();
    expect(base).toBeGreaterThanOrEqual(2 ** 31);

    setItem.mockRestore();
    expect(sequence.take()).toBe(base + 1);
  });

  it('ignores a stored value that is not a count', () => {
    sessionStorage.setItem('sq_rum_replay_next:s1', 'oops');
    expect(new SegmentSequence('s1').take()).toBe(0);
  });
});
