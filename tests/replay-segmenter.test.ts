import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Segmenter, Ring, META, FULL_SNAPSHOT, INCREMENTAL, SEGMENT_MAX_AGE_MS, SEGMENT_MAX_BYTES, RING_MAX_BYTES, type Segment } from '../src/replay/segmenter';

const entry = (type: number, t: number, size = 10, css?: string[]) => ({ json: JSON.stringify({ type, t, pad: 'x'.repeat(Math.max(0, size - 30)) }), type, t, css });

describe('Segmenter', () => {
  let out: Segment[];
  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
  });
  afterEach(() => vi.useRealTimers());

  it('opens a segment at each Meta event, with its full snapshot', () => {
    const s = new Segmenter((x) => out.push(x));
    s.add(entry(META, 1));
    s.add(entry(FULL_SNAPSHOT, 1));
    s.add(entry(INCREMENTAL, 2));
    s.add(entry(META, 3));
    s.close();
    expect(out.map((x) => x.json.map((j) => JSON.parse(j).type))).toEqual([[META, FULL_SNAPSHOT, INCREMENTAL], [META]]);
    expect(out[0]).toMatchObject({ ft: 1, lt: 2, fs: true });
    expect(out[1].fs).toBe(false);
  });

  it('counts the joined length and carries the inline stylesheets', () => {
    const s = new Segmenter((x) => out.push(x));
    const a = entry(INCREMENTAL, 1, 50, ['sheet-a']);
    const b = entry(INCREMENTAL, 2, 70, ['sheet-b']);
    s.add(a);
    s.add(b);
    s.close();
    expect(out[0].bytes).toBe(`${a.json},${b.json}`.length);
    expect(out[0].css).toEqual(['sheet-a', 'sheet-b']);
    expect(out[0].mem).toBe(out[0].bytes + 'sheet-a'.length + 'sheet-b'.length);
  });

  it(`closes at about ${SEGMENT_MAX_BYTES} bytes and sends a larger event alone`, () => {
    const s = new Segmenter((x) => out.push(x));
    for (let i = 0; i < 6; i++) s.add(entry(INCREMENTAL, i, 600_000));
    s.add(entry(INCREMENTAL, 9, SEGMENT_MAX_BYTES + 10));
    s.add(entry(INCREMENTAL, 10));
    s.close();
    for (const x of out) expect(x.bytes <= SEGMENT_MAX_BYTES || x.json.length === 1).toBe(true);
    expect(out.find((x) => x.lt === 9)!.json).toHaveLength(1);
  });

  it('keeps a large full snapshot with the Meta event before it', () => {
    const s = new Segmenter((x) => out.push(x));
    s.add(entry(META, 1));
    s.add(entry(FULL_SNAPSHOT, 1, SEGMENT_MAX_BYTES + 100));
    s.close();
    expect(out).toHaveLength(1);
    expect(out[0].json).toHaveLength(2);
  });

  it(`closes a segment once its first event is ${SEGMENT_MAX_AGE_MS} ms old, then reports it`, () => {
    const onAge = vi.fn();
    const s = new Segmenter((x) => out.push(x), SEGMENT_MAX_AGE_MS, onAge);
    s.add(entry(INCREMENTAL, 1));
    vi.advanceTimersByTime(SEGMENT_MAX_AGE_MS - 1);
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(out).toHaveLength(1);
    expect(onAge).toHaveBeenCalledTimes(1);
  });

  it('in buffer mode holds a segment open however old it gets', () => {
    const s = new Segmenter((x) => out.push(x), Infinity);
    s.add(entry(INCREMENTAL, 1));
    vi.advanceTimersByTime(10 * 60_000);
    expect(out).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards the open segment unsent, timer and all', () => {
    const s = new Segmenter((x) => out.push(x));
    s.add(entry(INCREMENTAL, 1));
    s.discard();
    vi.advanceTimersByTime(SEGMENT_MAX_AGE_MS);
    expect(out).toHaveLength(0);
    expect(s.empty).toBe(true);
  });
});

describe('Ring', () => {
  const seg = (fs: boolean, ft: number, lt: number, bytes = 100): Segment => ({ json: ['{}'], bytes, mem: bytes, ft, lt, fs, css: [] });

  it('keeps the current and the previous checkout, oldest first', () => {
    const r = new Ring();
    r.push(seg(true, 0, 10));
    r.push(seg(false, 10, 60));
    r.push(seg(true, 60, 70));
    r.push(seg(false, 70, 120));
    r.push(seg(true, 120, 130));
    const taken = r.take(0);
    expect(taken.map((s) => s.ft)).toEqual([60, 70, 120]);
    expect(r.bytes).toBe(0);
  });

  it(`drops the older checkout past ${RING_MAX_BYTES} bytes`, () => {
    const r = new Ring();
    r.push(seg(true, 0, 10, 3_000_000));
    r.push(seg(true, 10, 20, 1_000_000));
    r.trim(1_500_000);
    expect(r.take(0).map((s) => s.ft)).toEqual([10]);
  });

  it('keeps the current base until the recorder can replace an oversized run', () => {
    const r = new Ring();
    r.push(seg(true, 0, 10, 6_000_000));
    r.trim(1_000_000);
    expect(r.take(0)).toHaveLength(1);
  });

  it('drops a stale older checkout at the trigger, and a stale last one only when told', () => {
    const r = new Ring();
    r.push(seg(true, 0, 10));
    r.push(seg(true, 500_000, 500_010));
    expect(r.take(400_000).map((s) => s.ft)).toEqual([500_000]);
    r.push(seg(true, 0, 10));
    expect(r.take(400_000)).toHaveLength(1);
    r.push(seg(true, 0, 10));
    expect(r.take(400_000, false)).toEqual([]);
  });

  it('keeps only the previous checkout once a new one begins', () => {
    const r = new Ring();
    r.push(seg(true, 0, 10));
    r.push(seg(true, 10, 20));
    r.begin();
    expect(r.take(0).map((s) => s.ft)).toEqual([10]);
  });

  it('bounds serialized bytes without double-counting inline stylesheets', () => {
    const r = new Ring();
    r.push({ ...seg(true, 0, 10, 1_000), mem: 3_000_000 });
    r.push({ ...seg(true, 10, 20, 1_000), mem: 2_500_000 });
    r.trim();
    expect(r.take(0).map((s) => s.ft)).toEqual([0, 10]);
  });
});
