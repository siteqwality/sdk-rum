import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ReplayRecorder,
  SegmentBuffer,
  SEGMENT_TARGET_BYTES,
  SEGMENT_MAX_EVENTS,
  SEGMENT_MAX_AGE_MS,
  CHECKOUT_EVERY_MS,
  type ReplaySegment,
} from '../src/replay/recorder';
import { MAX_SEGMENT_BYTES } from '../src/replay/transport';
import { createUrlSanitizer } from '../src/privacy/url';

type Emit = (event: unknown, isCheckout?: boolean) => void;

const rrweb = vi.hoisted(() => {
  const state = {
    options: null as null | Record<string, unknown> & { emit: Emit },
    calls: [] as Array<{ emit: Emit; stopped: boolean }>,
    nodes: new Map<number, unknown>(),
  };
  const record = Object.assign(
    (options: Record<string, unknown> & { emit: Emit }) => {
      state.options = options;
      const call = { emit: options.emit, stopped: false };
      state.calls.push(call);
      return () => {
        call.stopped = true;
      };
    },
    { mirror: { getNode: (id: number) => state.nodes.get(id) ?? null } },
  );
  return { state, record };
});

vi.mock('@rrweb/record', () => ({ record: rrweb.record }));

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** The request body the transport builds for a segment, at its widest. */
const body = (s: ReplaySegment) =>
  bytes(
    `{"session_id":"00000000-0000-4000-8000-000000000000","segment_index":4294967295,"events":[${s.json.join(',')}]}`,
  );

const events = (s: ReplaySegment) => s.json.map((j) => JSON.parse(j));
const types = (s: ReplaySegment) => events(s).map((e) => e.type as number);

const meta = (href = 'https://example.com/', timestamp = 1) => ({
  type: 4,
  timestamp,
  data: { href, width: 1, height: 1 },
});
const full = (pad = 0, timestamp = 1) => ({
  type: 2,
  timestamp,
  data: { node: { type: 0, id: 1, pad: 'x'.repeat(pad) } },
});
const move = (n: number, pad = 0) => ({
  type: 3,
  timestamp: n,
  data: { source: 1, n, pad: 'x'.repeat(pad) },
});

function collect() {
  const segments: ReplaySegment[] = [];
  return { segments, buffer: new SegmentBuffer((s) => segments.push(s)) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SegmentBuffer', () => {
  it('opens a segment at each Meta event and sends its full snapshot at once', () => {
    const { segments, buffer } = collect();
    buffer.add(meta());
    buffer.add(full());
    buffer.add(move(1));
    buffer.add(move(2));
    buffer.add(meta());
    buffer.add(full());
    buffer.add(move(3));
    buffer.flush();

    expect(segments.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(segments.map(types)).toEqual([[4, 2], [3, 3], [4, 2], [3]]);
    expect(segments.map((s) => s.snapshot)).toEqual([true, false, true, false]);
  });

  it('counts the bytes of the joined events as UTF-8', () => {
    const { segments, buffer } = collect();
    buffer.add({ type: 3, data: { text: 'héllo 日本 😀' } });
    buffer.add(move(1));
    buffer.flush();
    expect(segments[0].bytes).toBe(bytes(segments[0].json.join(',')));
  });

  it('keeps each request body within the byte target', () => {
    const { segments, buffer } = collect();
    const pad = 100_000;
    // Seven fit under the target with the request fields, an eighth would not.
    expect(bytes(JSON.stringify(move(0, pad))) * 7 + 200).toBeLessThan(SEGMENT_TARGET_BYTES);
    expect(bytes(JSON.stringify(move(0, pad))) * 8).toBeGreaterThan(SEGMENT_TARGET_BYTES);

    for (let i = 0; i < 16; i++) buffer.add(move(i, pad));
    buffer.flush();

    expect(segments.map((s) => s.json.length)).toEqual([7, 7, 2]);
    for (const s of segments) expect(body(s)).toBeLessThanOrEqual(SEGMENT_TARGET_BYTES);
    const order = segments.flatMap((s) => events(s).map((e) => e.data.n));
    expect(order).toEqual([...Array(16).keys()]);
  });

  it('holds the byte target with events of every size', () => {
    const { segments, buffer } = collect();
    for (let i = 0; i < 400; i++) buffer.add(move(i, (i * 7919) % 60_000));
    buffer.flush();
    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) expect(body(s)).toBeLessThanOrEqual(SEGMENT_TARGET_BYTES);
  });

  it('sends an event over the byte target on its own', () => {
    const { segments, buffer } = collect();
    buffer.add(move(1));
    buffer.add(move(2, SEGMENT_TARGET_BYTES + 1));
    buffer.add(move(3));
    buffer.flush();
    expect(segments.map((s) => s.json.length)).toEqual([1, 1, 1]);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('keeps a large full snapshot with the Meta event before it', () => {
    const { segments, buffer } = collect();
    buffer.add(move(1, 300_000));
    buffer.add(meta());
    buffer.add(full(2_000_000));
    buffer.add(move(2));
    buffer.flush();
    expect(segments.map(types)).toEqual([[3], [4, 2], [3]]);
  });

  it('refuses a full snapshot too large to send, keeping its Meta event', () => {
    const { segments, buffer } = collect();
    buffer.add(meta());
    expect(buffer.add(full(MAX_SEGMENT_BYTES))).toBe(false);
    buffer.flush();
    expect(segments.map(types)).toEqual([[4]]);
    expect(segments[0].snapshot).toBe(false);
  });

  it('numbers segments from the index source it is given', () => {
    const segments: ReplaySegment[] = [];
    let next = 41;
    const buffer = new SegmentBuffer((s) => segments.push(s), () => next++);
    buffer.add(move(1));
    buffer.flush();
    buffer.add(move(2));
    buffer.flush();
    expect(segments.map((s) => s.index)).toEqual([41, 42]);
  });

  it('closes a segment at the event cap', () => {
    const { segments, buffer } = collect();
    for (let i = 0; i < SEGMENT_MAX_EVENTS * 2 + 3; i++) buffer.add(move(i));
    buffer.flush();
    expect(segments.map((s) => s.json.length)).toEqual([
      SEGMENT_MAX_EVENTS,
      SEGMENT_MAX_EVENTS,
      3,
    ]);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('closes a segment once its first event is SEGMENT_MAX_AGE_MS old', () => {
    const { segments, buffer } = collect();
    buffer.add(move(1));
    vi.advanceTimersByTime(SEGMENT_MAX_AGE_MS - 1);
    buffer.add(move(2));
    expect(segments).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(segments.map((s) => s.json.length)).toEqual([2]);

    // An idle buffer holds no timer.
    expect(vi.getTimerCount()).toBe(0);
    buffer.add(move(3));
    vi.advanceTimersByTime(SEGMENT_MAX_AGE_MS);
    expect(segments.map((s) => s.json.length)).toEqual([2, 1]);
  });

  it('holds no timer after a snapshot', () => {
    const { segments, buffer } = collect();
    buffer.add(move(1));
    vi.advanceTimersByTime(SEGMENT_MAX_AGE_MS - 1);
    buffer.add(meta());
    buffer.add(full());
    expect(segments.map(types)).toEqual([[3], [4, 2]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('marks a flush as final', () => {
    const { segments, buffer } = collect();
    buffer.add(move(1));
    buffer.flush(true);
    buffer.add(move(2));
    buffer.flush();
    expect(segments.map((s) => s.final)).toEqual([true, false]);
  });
});

describe('ReplayRecorder', () => {
  let recorder: ReplayRecorder;
  let segments: ReplaySegment[];

  const SESSION = 'session-1';

  beforeEach(() => {
    rrweb.state.options = null;
    rrweb.state.calls = [];
    rrweb.state.nodes.clear();
    sessionStorage.clear();
    recorder = new ReplayRecorder();
    segments = [];
  });

  afterEach(() => {
    recorder.stop();
  });

  async function start(maskText = false, sessionId = SESSION) {
    await recorder.start(
      sessionId,
      (s) => segments.push(s),
      { maskInputs: true, maskText },
      createUrlSanitizer(),
    );
    return rrweb.state.options!;
  }

  it('records with periodic checkouts, every input and the app privacy settings', async () => {
    const options = await start();
    expect(options).toMatchObject({
      checkoutEveryNms: CHECKOUT_EVERY_MS,
      sampling: { mousemove: 50, scroll: 150 },
      slimDOMOptions: 'all',
      inlineStylesheet: true,
      recordCrossOriginIframes: false,
      recordCanvas: false,
      maskAllInputs: true,
    });
    expect(options.sampling).not.toHaveProperty('input');
    expect(options.maskTextSelector).toBeUndefined();

    recorder.stop();
    recorder = new ReplayRecorder();
    expect((await start(true)).maskTextSelector).toBe('*');
  });

  it('minimises the Meta event URL', async () => {
    const { emit } = await start();
    emit(meta('https://example.com/a?token=secret'));
    emit(full());
    expect(events(segments[0])[0].data.href).toBe('https://example.com/a');
  });

  it('stops recording a page whose snapshot is too large, sending only its Meta event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { emit } = await start();
    emit(meta());
    emit(full(MAX_SEGMENT_BYTES));
    emit(move(2));
    await Promise.resolve();

    expect(rrweb.state.calls[0].stopped).toBe(true);
    expect(segments.map(types)).toEqual([[4]]);
    expect(warn).toHaveBeenCalledTimes(1);

    emit(move(3));
    vi.advanceTimersByTime(CHECKOUT_EVERY_MS);
    expect(segments).toHaveLength(1);
  });

  it('drops the document of a blocked iframe only', async () => {
    const blocked = document.createElement('iframe');
    blocked.className = 'rr-block';
    rrweb.state.nodes.set(7, blocked);
    rrweb.state.nodes.set(8, document.createElement('iframe'));
    const attach = (parentId: number) => ({
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        isAttachIframe: true,
        adds: [{ parentId, nextId: null, node: { type: 0, id: 99, childNodes: [] } }],
        removes: [],
        texts: [],
        attributes: [],
      },
    });

    const { emit } = await start();
    emit(meta());
    emit(full());
    emit(attach(7));
    emit(attach(8));
    recorder.stop();

    expect(events(segments[1]).map((e) => e.data.adds[0].parentId)).toEqual([8]);
  });

  it('sends the open segment when stopped', async () => {
    const { emit } = await start();
    emit(meta());
    emit(full());
    emit(move(2));
    recorder.stop();
    expect(segments.map((s) => s.json.length)).toEqual([2, 1]);
    vi.advanceTimersByTime(SEGMENT_MAX_AGE_MS);
    expect(segments).toHaveLength(2);
  });

  it('sends the open segment as final on pagehide, and plainly when hidden', async () => {
    const { emit } = await start();
    emit(meta());
    emit(full());
    emit(move(2));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    expect(segments.map((s) => [s.json.length, s.final])).toEqual([
      [2, false],
      [1, true],
    ]);

    emit(move(3));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete (document as unknown as Record<string, unknown>).visibilityState;
    expect(segments.map((s) => s.final)).toEqual([false, true, false]);

    recorder.stop();
    emit(move(4));
    window.dispatchEvent(new Event('pagehide'));
    expect(segments).toHaveLength(3);
  });

  /** One page load: a fresh recorder, as a reload makes, in the same tab. */
  async function pageLoad(sessionId = SESSION, segmentCount = 2) {
    recorder.stop();
    recorder = new ReplayRecorder();
    const { emit } = await start(false, sessionId);
    emit(meta());
    emit(full());
    for (let i = 2; i < segmentCount; i++) {
      emit(move(i));
      vi.advanceTimersByTime(SEGMENT_MAX_AGE_MS);
    }
    emit(move(segmentCount));
    recorder.stop();
  }

  it('continues segment numbering across reloads of the same session', async () => {
    await pageLoad();
    await pageLoad();
    await pageLoad(SESSION, 3);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('numbers each session from 0', async () => {
    await pageLoad('session-a');
    await pageLoad('session-b');
    await pageLoad('session-a');
    expect(segments.map((s) => s.index)).toEqual([0, 1, 0, 1, 2, 3]);
  });
});
