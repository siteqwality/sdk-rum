// ReplayTransport: one segment at a time, in order, with backoff; restored from 1.x and extended.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ReplayTransport,
  MAX_BUFFERED_SEGMENTS,
  MAX_BUFFERED_BYTES,
  MAX_SEGMENT_BYTES,
  type ReplaySegment,
} from '../src/replay/transport';
import { KEEPALIVE_MAX_BYTES } from '../src/core/send';
import { budgetError } from '../src/core/budget';

let fetchSpy: ReturnType<typeof vi.fn>;

function okResponse() {
  return Promise.resolve({ ok: true, status: 202 });
}

function failResponse(status: number, headers: Record<string, string> = {}) {
  return Promise.resolve({
    ok: false,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
  });
}

/** A fetch that stays in flight until the test resolves it. */
function pendingResponse() {
  let resolve!: (res: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve({ ok: true, status: 202 }) };
}

function bodies(): unknown[][] {
  return fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body));
}

/** Lets settled fetches, and sends scheduled as microtasks, run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  fetchSpy = vi.fn(() => okResponse());
  vi.stubGlobal('fetch', fetchSpy);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ReplayTransport', () => {
  const REPLAY = 'https://replay.example.com/v1/segments';

  function seg(index: number, events: unknown[], extra: Partial<ReplaySegment> = {}): ReplaySegment {
    const json = events.map((e) => JSON.stringify(e));
    const bytes = new TextEncoder().encode(json.join(',')).length;
    return { index, json, bytes, snapshot: false, final: false, ...extra };
  }

  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('sends a large segment without keepalive instead of dropping it', async () => {
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, [{ data: 'x'.repeat(KEEPALIVE_MAX_BYTES) }]));
    await replay.sendSegment('s1', seg(1, [{ data: 'small' }]));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toContain('segment_index=0');
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(false);
    expect(fetchSpy.mock.calls[1][1].keepalive).toBe(true);
    expect(fetchSpy.mock.calls[1][1].credentials).toBe('omit');
    expect(fetchSpy.mock.calls[1][1].headers.Authorization).toBe('Bearer ct_test');
  });

  it('never rejects when the network fails', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await expect(
      replay.sendSegment('s1', seg(0, [])),
    ).resolves.toBeUndefined();
  });

  it('sends one segment at a time, in order', async () => {
    const first = pendingResponse();
    fetchSpy.mockImplementationOnce(() => first.promise);
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    void replay.sendSegment('s1', seg(0, []));
    void replay.sendSegment('s1', seg(1, []));
    void replay.sendSegment('s1', seg(2, []));
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    first.resolve();
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
      `${REPLAY}?session_id=s1&segment_index=0`,
      `${REPLAY}?session_id=s1&segment_index=1`,
      `${REPLAY}?session_id=s1&segment_index=2`,
    ]);
  });

  it.each([
    ['429', () => failResponse(429)],
    ['503', () => failResponse(503)],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('retries a segment after %s, with backoff', async (_, failure) => {
    fetchSpy.mockImplementationOnce(failure);
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, []));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toContain('segment_index=0');
  });

  it('honours Retry-After and holds later segments until then', async () => {
    fetchSpy.mockImplementationOnce(() => failResponse(429, { 'Retry-After': '20' }));
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, []));
    await replay.sendSegment('s1', seg(1, []));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
      `${REPLAY}?session_id=s1&segment_index=0`,
      `${REPLAY}?session_id=s1&segment_index=0`,
      `${REPLAY}?session_id=s1&segment_index=1`,
    ]);
  });

  it.each([400, 413])('drops a segment on %i and moves on', async (status) => {
    fetchSpy.mockImplementationOnce(() => failResponse(status));
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, []));
    await replay.sendSegment('s1', seg(1, []));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
      `${REPLAY}?session_id=s1&segment_index=0`,
      `${REPLAY}?session_id=s1&segment_index=1`,
    ]);
  });

  it.each([401, 403])('stops replay delivery on %i', async (status) => {
    fetchSpy.mockImplementationOnce(() => failResponse(status));
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, []));
    await replay.sendSegment('s1', seg(1, []));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('bounds the buffer by segment count, dropping the oldest', async () => {
    fetchSpy.mockImplementationOnce(() => failResponse(429, { 'Retry-After': '300' }));
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, []));
    for (let i = 1; i <= 15; i++) {
      await replay.sendSegment('s1', seg(i, []));
    }
    await vi.advanceTimersByTimeAsync(300_000);

    const sent = fetchSpy.mock.calls
      .slice(1)
      .map((c) => Number(new URL(c[0]).searchParams.get('segment_index')));
    expect(sent).toHaveLength(MAX_BUFFERED_SEGMENTS);
    expect(sent[0]).toBe(15 - MAX_BUFFERED_SEGMENTS + 1);
    expect(sent[sent.length - 1]).toBe(15);
  });

  it('bounds the buffer by bytes, dropping the oldest', async () => {
    fetchSpy.mockImplementationOnce(() => failResponse(429, { 'Retry-After': '300' }));
    const replay = new ReplayTransport(REPLAY, 'ct_test');
    const big = 'x'.repeat(Math.ceil(MAX_SEGMENT_BYTES * 0.9));

    await replay.sendSegment('s1', seg(0, [big]));
    await replay.sendSegment('s1', seg(1, [big]));
    await replay.sendSegment('s1', seg(2, [big]));
    await replay.sendSegment('s1', seg(3, [big]));
    await vi.advanceTimersByTimeAsync(300_000);

    const sent = fetchSpy.mock.calls
      .slice(1)
      .map((c) => Number(new URL(c[0]).searchParams.get('segment_index')));
    expect(MAX_SEGMENT_BYTES * 0.9 * 2).toBeLessThan(MAX_BUFFERED_BYTES);
    expect(sent).toEqual([2, 3]);
  });

  it('never sends a body over MAX_SEGMENT_BYTES, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replay = new ReplayTransport(REPLAY, 'ct_test');
    const huge = 'x'.repeat(MAX_SEGMENT_BYTES);

    await replay.sendSegment('s1', seg(0, [huge]));
    await replay.sendSegment('s1', seg(1, [huge]));
    await replay.sendSegment('s1', seg(2, [{ data: 'small' }]));

    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
      `${REPLAY}?session_id=s1&segment_index=2`,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sends a body just under MAX_SEGMENT_BYTES', async () => {
    const replay = new ReplayTransport(REPLAY, 'ct_test');
    const envelope = JSON.stringify({ session_id: 's1', segment_index: 0, events: [''] }).length;

    await replay.sendSegment('s1', seg(0, ['x'.repeat(MAX_SEGMENT_BYTES - envelope)]));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].body.length).toBe(MAX_SEGMENT_BYTES);
  });

  it('warns once on 413 and keeps sending later segments', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy
      .mockImplementationOnce(() => failResponse(413))
      .mockImplementationOnce(() => failResponse(413));
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    for (let i = 0; i < 4; i++) {
      await replay.sendSegment('s1', seg(i, [{ data: i }]));
    }

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  const sentIndexes = () =>
    fetchSpy.mock.calls.map((c) => Number(new URL(c[0]).searchParams.get('segment_index')));

  it('drops the segments built on a snapshot the intake refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy.mockImplementationOnce(() => failResponse(413));
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, [{ full: 1 }], { snapshot: true }));
    await replay.sendSegment('s1', seg(1, [{ move: 1 }]));
    await replay.sendSegment('s1', seg(2, [{ move: 2 }]));
    await replay.sendSegment('s1', seg(3, [{ full: 2 }], { snapshot: true }));
    await replay.sendSegment('s1', seg(4, [{ move: 3 }]));

    expect(sentIndexes()).toEqual([0, 3, 4]);
  });

  it('drops the segments built on a snapshot too large to send', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, ['x'.repeat(MAX_SEGMENT_BYTES)], { snapshot: true }));
    await replay.sendSegment('s1', seg(1, [{ move: 1 }]));
    await replay.sendSegment('s1', seg(2, [{ full: 2 }], { snapshot: true }));
    await replay.sendSegment('s1', seg(3, [{ move: 2 }]));

    expect(sentIndexes()).toEqual([2, 3]);
  });

  it('drops the segments queued behind a snapshot pushed out of the buffer', async () => {
    fetchSpy.mockImplementationOnce(() => failResponse(429, { 'Retry-After': '300' }));
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    await replay.sendSegment('s1', seg(0, [{ move: 0 }]));
    await replay.sendSegment('s1', seg(1, [{ full: 1 }], { snapshot: true }));
    for (let i = 2; i <= MAX_BUFFERED_SEGMENTS + 1; i++) {
      await replay.sendSegment('s1', seg(i, [{ move: i }]));
    }
    await replay.sendSegment('s1', seg(20, [{ full: 2 }], { snapshot: true }));
    await replay.sendSegment('s1', seg(21, [{ move: 21 }]));
    await vi.advanceTimersByTimeAsync(300_000);

    // 0 and the snapshot at 1 fell out, so 2-11 went with it.
    expect(sentIndexes()).toEqual([0, 20, 21]);
  });

  it('sends the final segment at once, alone and with keepalive', async () => {
    const first = pendingResponse();
    fetchSpy.mockImplementationOnce(() => first.promise);
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    void replay.sendSegment('s1', seg(0, [{ full: 1 }], { snapshot: true }));
    first.resolve();
    await settle();
    fetchSpy.mockImplementationOnce(() => pendingResponse().promise);
    void replay.sendSegment('s1', seg(1, [{ move: 1 }]));
    void replay.sendSegment('s1', seg(2, [{ move: 2 }]));
    void replay.sendSegment('s1', seg(3, [{ move: 3 }], { final: true }));

    expect(sentIndexes()).toEqual([0, 1, 3]);
    const final = fetchSpy.mock.calls[2][1];
    expect(final.keepalive).toBe(true);
    expect(JSON.parse(final.body)).toEqual({
      session_id: 's1',
      segment_index: 3,
      events: [{ move: 3 }],
    });
  });

  it('drops a final segment over the keepalive cap', async () => {
    const replay = new ReplayTransport(REPLAY, 'ct_test');
    await replay.sendSegment('s1', seg(0, ['x'.repeat(KEEPALIVE_MAX_BYTES)], { final: true }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drops a final segment while its snapshot is still on its way', async () => {
    fetchSpy.mockImplementationOnce(() => pendingResponse().promise);
    const replay = new ReplayTransport(REPLAY, 'ct_test');

    void replay.sendSegment('s1', seg(0, [{ full: 1 }], { snapshot: true }));
    void replay.sendSegment('s1', seg(1, [{ move: 1 }], { final: true }));
    await settle();

    expect(sentIndexes()).toEqual([0]);
  });

  it('stop drops everything queued and sends nothing more', async () => {
    const first = pendingResponse();
    fetchSpy.mockImplementationOnce(() => first.promise);
    const replay = new ReplayTransport(REPLAY, 'ct_test');
    void replay.sendSegment('s1', seg(0, [], { snapshot: true }));
    void replay.sendSegment('s1', seg(1, []));
    await settle();
    replay.stop();
    first.resolve();
    await settle();
    await replay.sendSegment('s1', seg(2, []));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a refusal from the request budget stops it, with no retry timer left', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(budgetError()));
    const replay = new ReplayTransport(REPLAY, 'ct_test');
    await replay.sendSegment('s1', seg(0, [], { snapshot: true }));
    await replay.sendSegment('s1', seg(1, []));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends through the send it is given, so the core keeps one keepalive budget', async () => {
    const send = vi.fn(async () => ({ kind: 'ok' as const }));
    const replay = new ReplayTransport(REPLAY, 'ct_test', fetchSpy as unknown as typeof fetch, send);
    await replay.sendSegment('s1', seg(0, [{ a: 1 }]));
    await replay.sendSegment('s1', seg(1, [{ a: 2 }], { final: true }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
