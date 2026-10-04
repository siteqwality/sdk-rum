// ReplayRecorder against a scripted rrweb: clock, segmenting, checkouts, the ring, CSS
// references, the size gate and the mutation throttle.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReplayRecorder, CHECKOUT_EVERY_MS, BUFFER_CHECKOUT_MS, SNAPSHOT_MAX_BYTES, RESYNC_MIN_MS, type ReplayPrivacy } from '../src/replay/recorder';
import { SEGMENT_MAX_AGE_MS, type Segment } from '../src/replay/segmenter';
import { NODE_BUCKET, WINDOW_MS } from '../src/replay/throttle';
import { CssStore, fnv1a64 } from '../src/replay/css';
import type { Stream } from '../src/replay/stream';
import { createUrlSanitizer, createTextUrlSanitizer } from '../src/core/url';

type Emit = (event: unknown) => void;

const rrweb = vi.hoisted(() => {
  const state = { calls: [] as Array<{ emit: Emit; stopped: boolean; options: Record<string, unknown> }>, nodes: new Map<number, unknown>(), fail: false };
  const live = () => state.calls.find((c) => !c.stopped);
  const record = Object.assign(
    (options: Record<string, unknown> & { emit: Emit }) => {
      if (state.fail) return undefined;
      const call = { emit: options.emit, stopped: false, options };
      state.calls.push(call);
      return () => {
        call.stopped = true;
      };
    },
    {
      mirror: { getNode: (id: number) => state.nodes.get(id) ?? null, getId: () => -1, has: (id: number) => id !== 404 },
      addCustomEvent(tag: string, payload: unknown) {
        const c = live();
        if (!c) throw new Error('not recording');
        c.emit({ type: 5, timestamp: 0, data: { tag, payload } });
      },
    },
  );
  return { state, record, live };
});

const url = createUrlSanitizer();
let now = 1_000_000;
let segments: Array<Segment & { stream: Stream }>;
let states: Array<[string, string | undefined]>;
let counts: string[];
let stream: Stream;
let recorder: ReplayRecorder;

const types = (s: Segment) => s.json.map((j) => JSON.parse(j).type as number);
const evs = (s: Segment) => s.json.map((j) => JSON.parse(j));
const emit = (e: Record<string, unknown>) => rrweb.live()!.emit({ timestamp: 0, ...e });
const meta = (href = 'https://example.com/') => emit({ type: 4, data: { href, width: 1, height: 1 } });
const full = (node: Record<string, unknown> = { type: 0, id: 1, childNodes: [] }) => emit({ type: 2, data: { node, initialOffset: { top: 0, left: 0 } } });
const move = (n = 1) => emit({ type: 3, data: { source: 1, positions: [{ x: n, y: n, id: 1, timeOffset: 0 }] } });
const textChange = (id: number, value: string) => emit({ type: 3, data: { source: 0, adds: [], removes: [], texts: [{ id, value }], attributes: [] } });
const adds = (pad: number) => emit({ type: 3, data: { source: 0, adds: [{ parentId: 1, nextId: null, node: { type: 3, id: 9, textContent: 'x'.repeat(pad) } }], removes: [], texts: [], attributes: [] } });

/** rrweb's start: a Meta event and a full snapshot, synchronously inside record(). */
function snapshotOnRecord(node?: Record<string, unknown>) {
  const original = rrweb.record;
  return vi.fn((options: Record<string, unknown> & { emit: Emit }) => {
    const stop = original(options);
    if (stop) {
      options.emit({ type: 4, timestamp: 0, data: { href: 'https://example.com/a?token=x', width: 1, height: 1 } });
      options.emit({ type: 2, timestamp: 0, data: { node: node ?? { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } });
    }
    return stop;
  });
}

function start(o: { buffer?: boolean; paused?: string; privacy?: Partial<ReplayPrivacy>; node?: Record<string, unknown> } = {}) {
  const record = Object.assign(snapshotOnRecord(o.node), { mirror: rrweb.record.mirror, addCustomEvent: rrweb.record.addCustomEvent });
  recorder.start({
    record: record as never,
    privacy: { maskInputs: true, maskAllText: false, blockSelector: '', ...o.privacy },
    url,
    text: createTextUrlSanitizer(url),
    now: () => now,
    stream: () => stream,
    buffer: o.buffer,
    onSegment: (s, st) => segments.push({ ...s, stream: st }),
    onStatus: (s, r) => states.push([s, r]),
    count: (name) => counts.push(name),
    paused: o.paused,
  });
  return record;
}

const advance = async (ms: number) => {
  now += ms;
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  rrweb.state.calls = [];
  rrweb.state.fail = false;
  segments = [];
  states = [];
  counts = [];
  stream = { s: 'sid', w: 'win', p: 'pl-1', q: 0, css: new CssStore() };
  recorder = new ReplayRecorder();
});

afterEach(() => {
  recorder.stop(true);
  vi.useRealTimers();
});

describe('ReplayRecorder, streaming', () => {
  it('stamps events from the SDK clock, minimises the Meta URL and sends the first snapshot at once', () => {
    start();
    expect(segments).toHaveLength(1);
    expect(types(segments[0])).toEqual([4, 2]);
    expect(evs(segments[0]).map((e) => e.timestamp)).toEqual([now, now]);
    expect(evs(segments[0])[0].data.href).toBe('https://example.com/a');
    expect(segments[0]).toMatchObject({ fs: true, ft: now, lt: now, stream });
    expect(states).toEqual([['recording', undefined]]);
  });

  it(`closes segments at ${SEGMENT_MAX_AGE_MS / 1000} s, so a busy page makes 3 requests a minute`, async () => {
    start();
    for (let s = 0; s < 60; s++) {
      move(s);
      await advance(1_000);
    }
    const steady = segments.slice(1);
    expect(steady).toHaveLength(3);
    for (const g of steady) expect(g.lt - g.ft).toBeLessThan(SEGMENT_MAX_AGE_MS);
  });

  it('takes the 3 minute checkout where a segment closes, opening a segment that is not sent at once', async () => {
    const record = start();
    for (let s = 0; s < CHECKOUT_EVERY_MS / 1000 + 25; s++) {
      move(s);
      await advance(1_000);
    }
    expect(record).toHaveBeenCalledTimes(2);
    const snaps = segments.filter((g) => g.fs);
    expect(snaps).toHaveLength(2);
    // The checkout's snapshot waits for its segment to fill, unlike the page's first.
    expect(types(snaps[1]).length).toBeGreaterThan(2);
    expect(rrweb.state.calls.filter((c) => !c.stopped)).toHaveLength(1);
  });

  it('pauses with sq-pause, sending the open segment, and resumes from a snapshot in its own segment', () => {
    start();
    move(1);
    recorder.pause('hidden');
    expect(evs(segments[1]).map((e) => e.data?.tag ?? e.type)).toEqual([3, 'sq-pause']);
    expect(evs(segments[1])[1].data.payload).toEqual({ reason: 'hidden' });
    expect(rrweb.live()).toBeUndefined();
    expect(states.at(-1)).toEqual(['paused', 'hidden']);
    recorder.resume();
    expect(states.at(-1)).toEqual(['recording', undefined]);
    // Unlike a page load's first, it waits for its segment: a tab switch costs one request.
    expect(segments).toHaveLength(2);
    move(2);
    recorder.pause('hidden');
    expect(types(segments[2])).toEqual([4, 2, 3, 5]);
  });

  it('a recorder started paused captures nothing until resumed', () => {
    const record = start({ paused: 'privacy_url' });
    expect(record).not.toHaveBeenCalled();
    expect(states).toEqual([['paused', 'privacy_url']]);
    recorder.resume();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('stop sends the open segment; stop(true) drops it', () => {
    start();
    move(1);
    recorder.stop();
    expect(segments).toHaveLength(2);
    recorder = new ReplayRecorder();
    segments = [];
    start();
    move(2);
    recorder.stop(true);
    expect(segments).toHaveLength(1);
  });

  it('unload stops rrweb and hands back the open segment as the tail; a restore starts a new stream', () => {
    const record = start();
    move(1);
    const tail = recorder.unload();
    expect(tail).toMatchObject({ stream, fs: false });
    expect(types(tail!)).toEqual([3]);
    expect(rrweb.live()).toBeUndefined();
    const next: Stream = { ...stream, p: 'pl-2', q: 0, css: new CssStore() };
    stream = next;
    recorder.restore();
    expect(record).toHaveBeenCalledTimes(2);
    expect(segments.at(-1)).toMatchObject({ fs: true, stream: next });
  });

  it('reports a recorder rrweb could not start', () => {
    rrweb.state.fail = true;
    start();
    expect(states).toEqual([['stopped', 'record_failed']]);
  });
});

describe('ReplayRecorder, buffering (design 5.4)', () => {
  it('holds everything until go(), with a checkout every 60 s keeping the last two', async () => {
    const record = start({ buffer: true });
    expect(states).toEqual([['buffering', undefined]]);
    const t0 = now;
    for (let s = 0; s < 150; s++) {
      move(s);
      await advance(1_000);
    }
    expect(segments).toEqual([]);
    expect(record).toHaveBeenCalledTimes(3);
    recorder.go();
    expect(states.at(-1)).toEqual(['recording', undefined]);
    // The replay starts at the older checkout kept: 60 to 120 s before the trigger.
    const first = segments[0];
    expect(first.fs).toBe(true);
    expect(now - first.ft).toBeGreaterThanOrEqual(BUFFER_CHECKOUT_MS);
    expect(now - first.ft).toBeLessThanOrEqual(2 * BUFFER_CHECKOUT_MS + 2_000);
    expect(first.ft).toBeGreaterThan(t0);
    expect(segments.filter((g) => g.fs)).toHaveLength(2);
    // Then it streams: 20 s segments.
    const sent = segments.length;
    for (let s = 0; s < 25; s++) {
      move(s);
      await advance(1_000);
    }
    expect(segments.length).toBe(sent + 1);
  });

  it('checks out early after 2.5 MB of changes, so the ring stays within its cap', async () => {
    const record = start({ buffer: true });
    const t0 = now;
    // The mutation window lets about 320 KB through each 5 s.
    for (let i = 0; i < 9; i++) {
      adds(300_000);
      await advance(WINDOW_MS);
    }
    expect(now - t0).toBeLessThan(BUFFER_CHECKOUT_MS);
    expect(record.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never sends a ring that never matched: stop and unload drop it', () => {
    start({ buffer: true });
    move(1);
    expect(recorder.unload()).toBeNull();
    recorder.stop();
    expect(segments).toEqual([]);
  });

  it("go() in a paused tab leaves its stale checkouts behind", async () => {
    start({ buffer: true });
    move(1);
    recorder.pause('hidden');
    await advance(10 * 60_000);
    recorder.go();
    expect(segments).toEqual([]);
    recorder.resume();
    recorder.stop();
    expect(segments.map((g) => types(g)[0])).toEqual([4]);
  });

  it('holds at most the previous checkout beside the one being recorded', async () => {
    start({ buffer: true });
    for (let s = 0; s < 200; s++) {
      move(s);
      await advance(1_000);
    }
    recorder.go();
    expect(segments.filter((g) => g.fs)).toHaveLength(2);
  });

  it('a pause while buffering keeps the ring; go() still sends it', () => {
    start({ buffer: true });
    move(1);
    recorder.pause('hidden');
    expect(segments).toEqual([]);
    recorder.go();
    expect(segments.map((g) => types(g))).toEqual([[4, 2, 3, 5]]);
    expect(states.at(-1)).toEqual(['paused', 'hidden']);
  });
});

describe('CSS references (design 5.5)', () => {
  const sheet = '.a{color:red}'.repeat(200);
  const page = () => ({ type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'style', attributes: { _cssText: sheet }, childNodes: [] }, { type: 2, id: 3, tagName: 'style', attributes: { _cssText: '.small{}' }, childNodes: [] }] });

  it('inlines a page load\'s first copy, then names it once the intake has it', () => {
    start({ node: page() });
    expect(segments[0].css).toEqual([sheet]);
    expect(segments[0].json[1]).toContain(sheet);
    stream.css.ack(segments[0].css);
    recorder.pause('idle');
    recorder.resume();
    recorder.pause('idle');
    const again = evs(segments.at(-1)!)[1];
    expect(again.data.node.childNodes[0].attributes._cssText).toBe(`sq-css:${fnv1a64(sheet)}`);
    // Short sheets always stay inline.
    expect(again.data.node.childNodes[1].attributes._cssText).toBe('.small{}');
  });

  it('inlines again until acknowledged, and never references in buffer mode', () => {
    start({ buffer: true, node: page() });
    recorder.pause('idle');
    recorder.resume();
    recorder.go();
    for (const g of segments.filter((s) => s.fs)) expect(g.json.join()).toContain(sheet);
  });

  it(`stops a page whose snapshot is over ${SNAPSHOT_MAX_BYTES} bytes, sending nothing of it`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    start({ node: { type: 0, id: 1, pad: 'x'.repeat(SNAPSHOT_MAX_BYTES) } });
    expect(segments).toEqual([]);
    expect(states).toEqual([['stopped', 'too_large']]);
    expect(rrweb.live()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a page over the cap only through a stylesheet the intake holds records once it is named', () => {
    const big = 'b{c:d}'.repeat(Math.ceil(SNAPSHOT_MAX_BYTES / 6) + 10);
    stream.css.ack([big]);
    start({ node: { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'style', attributes: { _cssText: big }, childNodes: [] }] } });
    expect(states).toEqual([['recording', undefined]]);
    expect(segments[0].json[1].length).toBeLessThan(1_000);
  });
});

describe('mutation throttle in the recorder', () => {
  it("coalesces one node's churn to its last value, about once a second", async () => {
    start();
    for (let i = 0; i < NODE_BUCKET + 500; i++) textChange(5, `v${i}`);
    await advance(1_000);
    recorder.stop();
    const texts = segments.flatMap((g) => evs(g)).filter((e) => e.type === 3).flatMap((e) => e.data.texts ?? []);
    expect(texts.length).toBeLessThan(NODE_BUCKET + 20);
    expect(texts.at(-1)).toEqual({ id: 5, value: `v${NODE_BUCKET + 499}` });
  });

  it('a flood over the global window drops mutations, marks the gap and resyncs once calm, at most every 30 s', async () => {
    const record = start();
    for (let i = 0; i < 400; i++) adds(2_000);
    expect(counts.filter((c) => c === 'replay_mutations_dropped').length).toBeGreaterThan(0);
    await advance(WINDOW_MS + 1_000);
    const marker = segments.flatMap((g) => evs(g)).find((e) => e.data?.tag === 'sq-throttle');
    expect(marker?.data.payload.dropped).toBeGreaterThan(0);
    expect(record).toHaveBeenCalledTimes(2);
    // A second flood right away is marked when calm, but resyncs only after RESYNC_MIN_MS.
    for (let i = 0; i < 400; i++) adds(2_000);
    await advance(WINDOW_MS + 1_000);
    expect(record).toHaveBeenCalledTimes(2);
    await advance(RESYNC_MIN_MS);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('a page that never calms still resyncs, at most every 30 s', async () => {
    const record = start();
    // About 80 KB a second, over the 64 KB a second the window allows.
    for (let s = 0; s < 70; s++) {
      for (let i = 0; i < 40; i++) adds(2_000);
      await advance(1_000);
    }
    const resyncs = record.mock.calls.length - 1;
    expect(resyncs).toBeGreaterThanOrEqual(1);
    expect(resyncs).toBeLessThanOrEqual(3);
    expect(segments.flatMap((g) => evs(g)).some((e) => e.data?.tag === 'sq-throttle')).toBe(true);
  });

  it('a resync asked for too soon is taken once RESYNC_MIN_MS has passed, not dropped', async () => {
    const record = start();
    recorder.resync();
    await advance(10);
    expect(record).toHaveBeenCalledTimes(2);
    await advance(10_000);
    recorder.resync();
    await advance(10_000);
    expect(record).toHaveBeenCalledTimes(2);
    await advance(RESYNC_MIN_MS);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('a pause in the middle of a flood still marks it', () => {
    start();
    for (let i = 0; i < 400; i++) adds(2_000);
    recorder.pause('hidden');
    const tags = segments.flatMap((g) => evs(g)).map((e) => e.data?.tag).filter(Boolean);
    expect(tags).toEqual(['sq-throttle', 'sq-pause']);
  });
});
