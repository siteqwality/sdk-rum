// ReplayTransport v2 (design 6.4): query index fields, gzip bodies, one at a time, in order.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { ReplayTransport, MAX_BUFFERED_SEGMENTS } from '../src/replay/transport';
import { streamFor, type Stream } from '../src/replay/stream';
import { send, KEEPALIVE_MAX_BYTES } from '../src/core/send';
import { budgetError } from '../src/core/budget';
import { VERSION } from '../src/version';
import type { Segment } from '../src/replay/segmenter';

let fetchSpy: ReturnType<typeof vi.fn>;
let n = 0;

const ok = () => Promise.resolve({ ok: true, status: 202 });
const fail = (status: number, headers: Record<string, string> = {}) =>
  Promise.resolve({ ok: false, status, headers: { get: (name: string) => headers[name] ?? null } });

function pending() {
  let resolve!: (res: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve: () => resolve({ ok: true, status: 202 }) };
}

function seg(events: unknown[], extra: Partial<Segment> = {}): Segment {
  const json = events.map((e) => JSON.stringify(e));
  const ts = events.map((e) => (e as { timestamp?: number }).timestamp ?? 0);
  const bytes = json.join(',').length;
  return { json, bytes, mem: bytes, ft: Math.min(...ts), lt: Math.max(...ts), fs: false, css: [], ...extra };
}
const snap = (t = 1, extra: Partial<Segment> = {}) => seg([{ type: 4, timestamp: t }, { type: 2, timestamp: t }], { fs: true, ...extra });
const inc = (t: number, pad = '') => seg([{ type: 3, timestamp: t, data: { source: 1, pad } }]);

const fresh = (): Stream => streamFor(`0199a6b2-7c3e-7f00-8a1b-${String(++n).padStart(12, '0')}`, 'win-1', `pl-${n}`);

async function decode(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  // jsdom's Blob (the fflate fallback's) and Node's (CompressionStream's) differ.
  const blob = body as Blob;
  const buf = typeof blob.arrayBuffer === 'function'
    ? await blob.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
      });
  return gunzipSync(Buffer.from(buf)).toString('utf8');
}

/** Lets compression (real I/O) and settled fetches run. */
async function until(cond: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(0);
  }
}
const settle = () => until(() => false, 20);

const urls = () => fetchSpy.mock.calls.map((c) => new URL(String(c[0])));
const query = (i: number) => Object.fromEntries(urls()[i].searchParams);

beforeEach(() => {
  fetchSpy = vi.fn(() => ok());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const make = (hooks = {}) => new ReplayTransport('https://in-replay.example.com', 'ct_1', fetchSpy as unknown as typeof fetch, send, hooks);

describe('ReplayTransport v2', () => {
  it('puts every 6.4 index field in the query and numbers each page load from 0', async () => {
    const t = make();
    const a = fresh();
    const b = fresh();
    void t.push(a, snap(100), 'r_err');
    void t.push(a, inc(150), 'r_err');
    void t.push(b, snap(200));
    await until(() => fetchSpy.mock.calls.length === 3);
    expect(urls()[0].origin + urls()[0].pathname).toBe('https://in-replay.example.com/v2/segments');
    expect(query(0)).toEqual({ s: a.s, w: 'win-1', p: a.p, q: '0', ft: '100', lt: '100', n: '2', fs: '1', r: 'r_err', v: VERSION });
    expect(query(1)).toEqual({ s: a.s, w: 'win-1', p: a.p, q: '1', ft: '150', lt: '150', n: '1', r: 'r_err', v: VERSION });
    expect(query(2)).toMatchObject({ s: b.s, p: b.p, q: '0', fs: '1' });
    expect(query(2).r).toBeUndefined();
  });

  it('sends a gzip JSON array of rrweb events, with the token and no cookies', async () => {
    const t = make();
    void t.push(fresh(), snap(5));
    await until(() => fetchSpy.mock.calls.length === 1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ct_1' });
    expect(init.credentials).toBe('omit');
    expect(typeof (init.body as Blob).size).toBe('number');
    expect(JSON.parse(await decode(init.body))).toEqual([{ type: 4, timestamp: 5 }, { type: 2, timestamp: 5 }]);
  });

  it('sends one segment at a time, in order, though later ones compress first', async () => {
    const first = pending();
    fetchSpy.mockImplementationOnce(() => first.promise);
    const t = make();
    const st = fresh();
    void t.push(st, seg([{ type: 2, timestamp: 1, big: 'x'.repeat(200_000) }], { fs: true }));
    void t.push(st, inc(2));
    void t.push(st, inc(3));
    await until(() => fetchSpy.mock.calls.length === 1);
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    first.resolve();
    await until(() => fetchSpy.mock.calls.length === 3);
    expect(urls().map((u) => u.searchParams.get('q'))).toEqual(['0', '1', '2']);
  });

  it.each([
    ['429', () => fail(429)],
    ['503', () => fail(503)],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('retries after %s with backoff, resending the same bytes', async (_, failure) => {
    fetchSpy.mockImplementationOnce(failure);
    const t = make();
    void t.push(fresh(), snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => fetchSpy.mock.calls.length === 2);
    const [a, b] = fetchSpy.mock.calls.map((c) => c[1].body as Blob);
    expect(b).toBe(a);
    expect(String(fetchSpy.mock.calls[1][0])).toBe(String(fetchSpy.mock.calls[0][0]));
  });

  it('honours Retry-After and holds later segments until then', async () => {
    fetchSpy.mockImplementationOnce(() => fail(429, { 'Retry-After': '120' }));
    const t = make();
    const st = fresh();
    void t.push(st, snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    void t.push(st, inc(2));
    await vi.advanceTimersByTimeAsync(119_000);
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => fetchSpy.mock.calls.length === 3);
    expect(urls().map((u) => u.searchParams.get('q'))).toEqual(['0', '0', '1']);
  });

  it('acknowledges inline stylesheets once the intake accepted their segment', async () => {
    const t = make();
    const st = fresh();
    const css = 'a{b:c}'.repeat(300);
    void t.push(st, snap(1, { css: [css] }));
    expect(st.css.ref(css)).toBeNull();
    await until(() => st.css.ref(css) !== null);
    expect(st.css.ref(css)).toMatch(/^sq-css:[0-9a-f]{16}$/);
  });

  it('drops a segment on 400 and moves on', async () => {
    fetchSpy.mockImplementationOnce(() => fail(400));
    const count = vi.fn();
    const t = make({ count });
    const st = fresh();
    void t.push(st, inc(1));
    void t.push(st, inc(2));
    await until(() => fetchSpy.mock.calls.length === 2);
    expect(count).toHaveBeenCalledWith('replay_segments_dropped');
  });

  it('a refused snapshot takes what built on it, forgets its stylesheets and asks for a new one', async () => {
    fetchSpy.mockImplementationOnce(() => fail(400));
    const lost = vi.fn();
    const t = make({ lost });
    const st = fresh();
    st.css.ack(['older'.repeat(300)]);
    void t.push(st, snap(1));
    void t.push(st, inc(2));
    void t.push(st, inc(3));
    await until(() => lost.mock.calls.length > 0);
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lost).toHaveBeenCalledWith(st);
    expect(st.css.size).toBe(0);
    // Later segments still cannot play, until the next snapshot.
    void t.push(st, inc(4));
    void t.push(st, snap(5));
    await until(() => fetchSpy.mock.calls.length === 2);
    expect(query(1)).toMatchObject({ fs: '1' });
  });

  it('a lost change asks the stream for a fresh snapshot, without dropping what follows', async () => {
    fetchSpy.mockImplementationOnce(() => ok()).mockImplementationOnce(() => fail(400));
    const lost = vi.fn();
    const t = make({ lost });
    const st = fresh();
    void t.push(st, snap(1));
    void t.push(st, inc(2));
    void t.push(st, inc(3));
    await until(() => fetchSpy.mock.calls.length === 3);
    expect(lost).toHaveBeenCalledWith(st);
    expect(urls().map((u) => u.searchParams.get('q'))).toEqual(['0', '1', '2']);
  });

  it('keeps only the gzip body once compressed, and never counts a segment it no longer holds', async () => {
    const first = pending();
    fetchSpy.mockImplementationOnce(() => first.promise);
    const t = make();
    const st = fresh();
    void t.push(st, snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    void t.push(st, inc(2, 'y'.repeat(500_000)));
    const internals = t as unknown as { queue: Array<{ text: string; body?: Blob | null }>; queued: number };
    await until(() => internals.queue[1]?.body !== undefined);
    expect(internals.queue[1].text).toBe('');
    expect(internals.queued).toBeLessThan(20_000);
    // Unloaded before its compression finished: the count stays sane.
    void t.push(st, inc(3, 'z'.repeat(800_000)));
    t.unload(null)();
    await settle();
    expect(internals.queued).toBeGreaterThanOrEqual(0);
    first.resolve();
  });

  it('warns once on 413', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy.mockImplementation(() => fail(413));
    const t = make();
    const st = fresh();
    void t.push(st, inc(1));
    void t.push(st, inc(2));
    await until(() => fetchSpy.mock.calls.length === 2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('stops delivery on %i', async (status) => {
    fetchSpy.mockImplementationOnce(() => fail(status));
    const t = make();
    const st = fresh();
    void t.push(st, snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    await settle();
    void t.push(st, inc(2));
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a refusal from the request budget stops it, with no retry timer left', async () => {
    fetchSpy.mockImplementationOnce(() => Promise.reject(budgetError()));
    const t = make();
    void t.push(fresh(), snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.idle).toBe(true);
  });

  it('bounds what it holds by count, dropping the oldest and what built on it', async () => {
    const first = pending();
    fetchSpy.mockImplementationOnce(() => first.promise);
    const count = vi.fn();
    const t = make({ count });
    const st = fresh();
    void t.push(st, snap(0));
    await until(() => fetchSpy.mock.calls.length === 1);
    for (let i = 1; i <= MAX_BUFFERED_SEGMENTS + 3; i++) void t.push(st, inc(i));
    first.resolve();
    await until(() => t.idle);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(MAX_BUFFERED_SEGMENTS + 1);
    expect(count).toHaveBeenCalledWith('replay_segments_dropped');
  });

  it('without CompressionStream it compresses with the fflate fallback', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const t = make();
    void t.push(fresh(), snap(9));
    await until(() => fetchSpy.mock.calls.length === 1, 2000);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    vi.unstubAllGlobals();
    expect(JSON.parse(await decode(init.body))).toEqual([{ type: 4, timestamp: 9 }, { type: 2, timestamp: 9 }]);
  });

  it('stop drops everything queued and sends nothing more', async () => {
    const first = pending();
    fetchSpy.mockImplementationOnce(() => first.promise);
    const t = make();
    const st = fresh();
    void t.push(st, snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    void t.push(st, inc(2));
    t.stop();
    first.resolve();
    void t.push(st, inc(3));
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayTransport.unload (pagehide)', () => {
  it('sends what is queued and the tail with keepalive, the tail last and final', async () => {
    const t = make();
    const st = fresh();
    const first = pending();
    fetchSpy.mockImplementationOnce(() => first.promise);
    void t.push(st, snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    void t.push(st, inc(2));
    const go = t.unload({ stream: st, seg: inc(3), rule: 'r_1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    go();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [, queued, tail] = fetchSpy.mock.calls;
    expect(queued[1].keepalive).toBe(true);
    expect(tail[1].keepalive).toBe(true);
    expect(new URL(String(tail[0])).searchParams.get('fin')).toBe('1');
    expect(new URL(String(tail[0])).searchParams.get('q')).toBe('2');
    // Not yet compressed: the tail goes as JSON.
    expect(tail[1].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(tail[1].body)).toEqual([{ type: 3, timestamp: 3, data: { source: 1, pad: '' } }]);
    first.resolve();
    await settle();
    // Nothing handed to keepalive is sent again.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('counts what cannot go: over the keepalive cap, or built on a lost snapshot', async () => {
    const count = vi.fn();
    const t = make({ count });
    const st = fresh();
    const go = t.unload({ stream: st, seg: inc(1, 'x'.repeat(KEEPALIVE_MAX_BYTES)) });
    go();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith('replay_tail_dropped', 1);

    fetchSpy.mockImplementationOnce(() => fail(400));
    const u = make({ count });
    const st2 = fresh();
    void u.push(st2, snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    await settle();
    count.mockClear();
    u.unload({ stream: st2, seg: inc(2) })();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith('replay_tail_dropped', 1);
  });

  it('a Retry-After holds the tail too', async () => {
    fetchSpy.mockImplementationOnce(() => fail(429, { 'Retry-After': '60' }));
    const count = vi.fn();
    const t = make({ count });
    const st = fresh();
    void t.push(st, snap(1));
    await until(() => fetchSpy.mock.calls.length === 1);
    await settle();
    t.unload({ stream: st, seg: inc(2) })();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The queued snapshot and the tail.
    expect(count).toHaveBeenCalledWith('replay_tail_dropped', 2);
  });
});
