import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  TransportManager,
  MAX_QUEUED_EVENTS,
  HIDDEN_SEND_SPACING_MS,
} from '../src/transport';
import {
  ReplayTransport,
  MAX_BUFFERED_SEGMENTS,
  MAX_BUFFERED_BYTES,
  MAX_SEGMENT_BYTES,
  type ReplaySegment,
} from '../src/replay/transport';
import { KEEPALIVE_MAX_BYTES } from '../src/send';

const ENDPOINT = 'https://rum.example.com/v1/measure';

let fetchSpy: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState = 'visible';
const live: TransportManager[] = [];

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

function transport(intervalMs = 60_000, endpoint = ENDPOINT): TransportManager {
  const t = new TransportManager(endpoint, 'ct_test', intervalMs);
  live.push(t);
  return t;
}

function bodies(): unknown[][] {
  return fetchSpy.mock.calls.map((c) => JSON.parse(c[1].body));
}

/** Lets settled fetches, and sends scheduled as microtasks, run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function hide(): void {
  visibility = 'hidden';
  window.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  fetchSpy = vi.fn(() => okResponse());
  vi.stubGlobal('fetch', fetchSpy);
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  // Listeners live on the shared jsdom window: a transport left behind would
  // answer the next test's visibilitychange with its own fetches.
  for (const t of live.splice(0)) t.destroy();
  delete (document as unknown as Record<string, unknown>).visibilityState;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TransportManager', () => {
  it('batches events and flushes on interval', () => {
    const t = transport(5000);

    t.enqueue({ type: 'view', url: '/page1' });
    t.enqueue({ type: 'view', url: '/page2' });

    // Not flushed yet
    expect(fetchSpy).not.toHaveBeenCalled();

    // Advance past the flush interval
    vi.advanceTimersByTime(5000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body).toHaveLength(2);
    expect(body[0].url).toBe('/page1');
    expect(body[1].url).toBe('/page2');
  });

  it('flushes immediately when queue reaches 50 events', () => {
    const t = transport();

    for (let i = 0; i < 50; i++) {
      t.enqueue({ type: 'view', url: `/page${i}` });
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toHaveLength(50);
  });

  it('does not flush when queue is empty', () => {
    transport(5000);

    vi.advanceTimersByTime(5000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not flush early while the page is still visible', () => {
    const t = transport();

    t.enqueue({ type: 'view', url: '/page1' });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flushes on destroy with a keepalive fetch, never sendBeacon', () => {
    // A beacon cannot carry the Authorization header the ingest gateway
    // authenticates, and browsers send it with credentials, which the intake's
    // wildcard CORS answer refuses. The last batch has to go like every other.
    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beaconSpy });

    const t = transport();
    t.enqueue({ type: 'view', url: '/page1' });
    t.destroy();

    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(true);
  });

  it('authenticates by header and sends no cookies', () => {
    const t = transport();
    t.enqueue({ type: 'view', url: '/page1' });
    t.destroy();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).not.toContain('token=');
    expect(options.headers.Authorization).toBe('Bearer ct_test');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.credentials).toBe('omit');
  });

  it('sends a batch over the keepalive cap without keepalive', () => {
    // Browsers refuse a keepalive request past 64 KiB outright. On a hidden
    // but still loaded page a plain request completes.
    const t = transport(60_000, 'https://rum.example.com/v1/errors');
    t.enqueue({ type: 'error', stack: 'x'.repeat(KEEPALIVE_MAX_BYTES) });
    t.destroy();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(false);
  });

  it('keeps a single request in flight', async () => {
    const first = pendingResponse();
    fetchSpy.mockImplementationOnce(() => first.promise);
    const t = transport(10_000);

    for (let i = 0; i < 50; i++) t.enqueue({ i });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Neither the size trigger nor the interval starts a second request.
    for (let i = 50; i < 100; i++) t.enqueue({ i });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Once it settles, the full batch that built up goes next.
    first.resolve();
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toEqual(Array.from({ length: 50 }, (_, k) => ({ i: 50 + k })));
  });
});

describe('TransportManager on a hidden page', () => {
  it('flushes at once with keepalive on visibilitychange to hidden', () => {
    const t = transport();
    t.enqueue({ type: 'view', url: '/page1' });

    hide();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(true);
  });

  it('flushes at once with keepalive on pagehide', () => {
    const t = transport();
    t.enqueue({ type: 'view', url: '/page1' });

    window.dispatchEvent(new Event('pagehide'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(true);
  });

  it('flushes on hide even while another request is in flight', () => {
    fetchSpy.mockImplementationOnce(() => pendingResponse().promise);
    const t = transport();
    for (let i = 0; i < 50; i++) t.enqueue({ i });
    t.enqueue({ type: 'view', url: '/late' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    hide();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toEqual([{ type: 'view', url: '/late' }]);
  });

  it('still sends the CLS/INP measure finalized after the flush on hide', async () => {
    // web-vitals finalizes CLS and INP on the way out. If its listener runs
    // after ours, the measure arrives once our flush is already in flight, and
    // a hidden page may never see another interval tick.
    fetchSpy.mockImplementationOnce(() => pendingResponse().promise);
    const t = transport();
    t.enqueue({ type: 'view', url: '/page1' });

    hide();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    t.enqueue({ type: 'vital', cls: 0.12, action_count: 3 });

    // No timer advance: this has to go out within the same event.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][1].keepalive).toBe(true);
    expect(bodies()[1]).toEqual([{ type: 'vital', cls: 0.12, action_count: 3 }]);
  });

  it('sends the late measure on pagehide even with a spaced send pending', async () => {
    // Already hidden, so a send is waiting out the spacing when the page
    // unloads. That timer will never fire; the late measure cannot wait on it.
    visibility = 'hidden';
    const t = transport();
    t.enqueue({ n: 1 });
    await settle();
    t.enqueue({ n: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('pagehide'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    t.enqueue({ type: 'vital', inp_ms: 180 });
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(bodies()[2]).toEqual([{ type: 'vital', inp_ms: 180 }]);
  });

  it('sends an event enqueued on an already hidden page within the same task', async () => {
    visibility = 'hidden';
    const t = transport();

    t.enqueue({ type: 'vital', cls: 0.12, action_count: 3 });
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(options.keepalive).toBe(true);
    expect(JSON.parse(options.body)[0].cls).toBe(0.12);
  });

  it('coalesces events enqueued together into one send, not one per event', async () => {
    visibility = 'hidden';
    const t = transport();

    t.enqueue({ n: 1 });
    t.enqueue({ n: 2 });
    t.enqueue({ n: 3 });
    await settle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('spaces further sends from a hidden page', async () => {
    visibility = 'hidden';
    const t = transport();

    t.enqueue({ n: 1 });
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    t.enqueue({ n: 2 });
    await vi.advanceTimersByTimeAsync(HIDDEN_SEND_SPACING_MS - 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toEqual([{ n: 2 }]);
  });

  it('does not loop when every send produces a resource entry of its own', async () => {
    // The incident: each POST to the ingest API showed up as a resource entry,
    // was enqueued, and on a hidden page was sent at once, producing another
    // entry. Simulate an observer that records every request we make, after it
    // completes, with no own-endpoint filter in front of it.
    let t!: TransportManager;
    let emitted = 0;
    fetchSpy.mockImplementation(() => {
      if (emitted < 1000) {
        emitted++;
        void Promise.resolve().then(() =>
          t.enqueue({
            type: 'resource',
            resource_url: 'https://rum.example.com/v1/events',
          }),
        );
      }
      return okResponse();
    });
    t = transport(10_000, 'https://rum.example.com/v1/events');
    t.enqueue({ type: 'action' });

    hide();
    await vi.advanceTimersByTimeAsync(60_000);

    // The flush on hide, the one late send, then one per spacing interval.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(
      60_000 / HIDDEN_SEND_SPACING_MS + 2,
    );
    expect(emitted).toBeLessThan(1000);
  });
});

describe('TransportManager retries', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it.each([
    ['429', () => failResponse(429)],
    ['503', () => failResponse(503)],
    ['500', () => failResponse(500)],
    ['408', () => failResponse(408)],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('retries the batch after %s, with backoff', async (_, failure) => {
    fetchSpy.mockImplementationOnce(failure);
    const t = transport();
    t.enqueue({ n: 1 });
    t.flush();
    await settle();

    // First backoff ceiling is 2s; Math.random() = 0.5 puts this retry at 1s.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toEqual([{ n: 1 }]);
  });

  it('honours Retry-After in seconds', async () => {
    fetchSpy.mockImplementationOnce(() => failResponse(429, { 'Retry-After': '30' }));
    const t = transport();
    t.enqueue({ n: 1 });
    t.flush();
    await settle();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After as an HTTP-date', async () => {
    const at = new Date(Date.now() + 45_000).toUTCString();
    fetchSpy.mockImplementationOnce(() => failResponse(503, { 'Retry-After': at }));
    const t = transport();
    t.enqueue({ n: 1 });
    t.flush();
    await settle();

    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('sends nothing on the interval or on size while backing off', async () => {
    fetchSpy.mockImplementationOnce(() => failResponse(429, { 'Retry-After': '120' }));
    const t = transport(10_000);
    t.enqueue({ n: 0 });
    t.flush();
    await settle();

    for (let i = 1; i <= 60; i++) t.enqueue({ n: i });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The failed batch goes back at the front of the queue.
    expect(bodies()[1][0]).toEqual({ n: 0 });
  });

  it('makes one keepalive attempt on hide while backing off', async () => {
    fetchSpy.mockImplementation(() => failResponse(429, { 'Retry-After': '300' }));
    const t = transport();
    t.enqueue({ n: 0 });
    t.flush();
    await settle();
    for (let i = 1; i <= 120; i++) t.enqueue({ n: i });

    hide();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][1].keepalive).toBe(true);
    expect(bodies()[1]).toHaveLength(50);
    expect(bodies()[1][0]).toEqual({ n: 0 });
  });

  it.each([400, 413])('drops the batch on %i without retrying', async (status) => {
    fetchSpy.mockImplementationOnce(() => failResponse(status));
    const t = transport();
    t.enqueue({ n: 1 });
    t.flush();
    await settle();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Later batches still go.
    t.enqueue({ n: 2 });
    t.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toEqual([{ n: 2 }]);
  });

  it.each([401, 403])('stops sending for the rest of the page on %i', async (status) => {
    fetchSpy.mockImplementationOnce(() => failResponse(status));
    const t = transport(10_000);
    t.enqueue({ n: 1 });
    t.flush();
    await settle();

    for (let i = 2; i < 100; i++) t.enqueue({ n: i });
    t.flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    await settle();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caps the queue, dropping the oldest events', async () => {
    fetchSpy.mockImplementationOnce(() => failResponse(429, { 'Retry-After': '300' }));
    const t = transport();
    t.enqueue({ n: 0 });
    t.flush();
    await settle();

    for (let i = 1; i <= 1500; i++) t.enqueue({ n: i });
    await vi.advanceTimersByTimeAsync(300_000);

    const delivered = bodies().slice(1).flat() as { n: number }[];
    expect(delivered).toHaveLength(MAX_QUEUED_EVENTS);
    expect(delivered[0].n).toBe(1500 - MAX_QUEUED_EVENTS + 1);
    expect(delivered[delivered.length - 1].n).toBe(1500);
  });

  it('resets the backoff after a success', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    fetchSpy
      .mockImplementationOnce(() => failResponse(503))
      .mockImplementationOnce(() => failResponse(503))
      .mockImplementationOnce(() => failResponse(503))
      .mockImplementationOnce(() => okResponse())
      .mockImplementationOnce(() => failResponse(503));
    const t = transport();
    t.enqueue({ n: 1 });
    t.flush();
    await settle();

    // Ceilings 2s, 4s, 8s, each retry at just under its ceiling.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // The next failure starts again from the 2s ceiling, not 16s.
    t.enqueue({ n: 2 });
    t.flush();
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });
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
});
