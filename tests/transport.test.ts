import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTransport, FLUSH_INTERVAL_MS, URGENT_FLUSH_MS, HIDDEN_SPACING_MS, MAX_PENDING, type Ctx } from '../src/core/transport';
import { BACKOFF_MAX_MS } from '../src/core/send';
import { VERSION } from '../src/version';

interface Call {
  url: string;
  init: RequestInit;
  body: { v: number; sdk: string; sent_at: number; ctx: Ctx; events: Array<{ k: string; t: number; n?: number }> };
  gzip: boolean;
}

let calls: Call[];
let status: number;
let counts: Record<string, number>;
let stopped: boolean;

async function decode(body: unknown) {
  if (typeof body === 'string') return { text: body, gzip: false };
  return { text: await new Response((body as Blob).stream().pipeThrough(new DecompressionStream('gzip'))).text(), gzip: true };
}

const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
  const { text, gzip } = await decode(init.body);
  calls.push({ url, init, body: JSON.parse(text), gzip });
  return new Response('', { status });
});

const ctx = (session_id = 's1', page_load_id = 'p1', extra: Record<string, unknown> = {}): Ctx => ({ session_id, page_load_id, ...extra });
const ev = (n: number, extra: Record<string, unknown> = {}) => ({ k: 'custom', t: 1000 + n, n, ...extra });

function make() {
  return createTransport({
    url: 'https://in.test/v2/batch',
    token: 'ct',
    fetch: fakeFetch as unknown as typeof fetch,
    count: (name, n = 1) => (counts[name] = (counts[name] ?? 0) + n),
    onStop: () => (stopped = true),
  });
}

function hidden(state: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (state ? 'hidden' : 'visible') });
}

async function drain() {
  for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  status = 202;
  counts = {};
  stopped = false;
  fakeFetch.mockClear();
  hidden(false);
});

afterEach(() => {
  hidden(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('batches', () => {
  it('sends on the interval as {v, sent_at, sdk, ctx, events}', async () => {
    const t = make();
    t.push(ev(1), ctx());
    t.push(ev(2), ctx());
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await drain();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ v: 2, sdk: VERSION, ctx: { session_id: 's1' } });
    expect(calls[0].body.events.map((e) => e.n)).toEqual([1, 2]);
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer ct' });
  });

  it('flushes an urgent event (an error) within a second', async () => {
    const t = make();
    t.push(ev(1), ctx(), true);
    await vi.advanceTimersByTimeAsync(URGENT_FLUSH_MS);
    await drain();
    expect(calls).toHaveLength(1);
  });

  it('an urgent event queued while a request is in flight goes as soon as it settles', async () => {
    const t = make();
    let release: () => void = () => {};
    fakeFetch.mockImplementationOnce(async (url: string, init: RequestInit) => {
      await new Promise<void>((r) => (release = r));
      calls.push({ url, init, body: JSON.parse(String(init.body)), gzip: false });
      return new Response('', { status: 202 });
    });
    t.push(ev(1), ctx());
    t.flush();
    t.push(ev(2), ctx(), true);
    await vi.advanceTimersByTimeAsync(URGENT_FLUSH_MS);
    release();
    await drain();
    expect(calls.map((c) => c.body.events.map((e) => e.n))).toEqual([[1], [2]]);
  });

  it('splits batches by session and page load, using the latest ctx of each', async () => {
    const t = make();
    t.push(ev(1), ctx('s1', 'p1', { user: undefined }));
    t.push(ev(2), ctx('s1', 'p1', { user: { id: 'u' } }));
    t.push(ev(3), ctx('s2', 'p1'));
    t.hide.call(null);
    hidden(true);
    t.hide();
    await drain();
    expect(calls.map((c) => [c.body.ctx.session_id, c.body.events.map((e) => e.n)])).toEqual([
      ['s1', [1, 2]],
      ['s2', [3]],
    ]);
    expect(calls[0].body.ctx).toMatchObject({ user: { id: 'u' } });
  });

  it('gzips bodies over 1 KB while the page lives', { timeout: 20_000 }, async () => {
    const t = make();
    t.push(ev(1, { big: 'x'.repeat(5000) }), ctx());
    t.push(ev(2), ctx());
    t.hide();
    // gzip runs on real streams (the zlib thread pool), which fake timers do not hurry.
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 15_000 });
    expect(calls[0].gzip).toBe(true);
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
  });

  it('caps a batch at 500 events', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const t = make();
    t.hold(true);
    t.hold(false);
    for (let i = 0; i < 700; i++) t.push(ev(i), ctx());
    await drain();
    t.hide();
    await drain();
    expect(calls.reduce((a, c) => a + c.body.events.length, 0)).toBe(700);
    expect(calls.every((c) => c.body.events.length <= 500)).toBe(true);
  });

  it('drops the oldest past 1000 queued events and counts them', async () => {
    status = 503;
    const t = make();
    t.push(ev(0), ctx());
    t.flush();
    await drain();
    for (let i = 1; i <= 1100; i++) t.push(ev(i), ctx());
    expect(counts.queue_overflow).toBeGreaterThan(0);
    expect(t.size).toBe(1000);
  });
});

describe('failures', () => {
  it('retries with backoff on 5xx and keeps the batch', async () => {
    status = 503;
    const t = make();
    t.push(ev(1), ctx());
    t.flush();
    await drain();
    expect(calls).toHaveLength(1);
    status = 202;
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    await drain();
    expect(calls.at(-1)!.body.events.map((e) => e.n)).toEqual([1]);
    expect(t.size).toBe(0);
  });

  it('stops for good on 401 or 403', async () => {
    status = 403;
    const t = make();
    t.push(ev(1), ctx());
    t.flush();
    await drain();
    expect(stopped).toBe(true);
    expect(t.stopped).toBe(true);
    t.push(ev(2), ctx());
    expect(t.size).toBe(0);
  });

  it('honours Retry-After: nothing goes on hide or pagehide until it passes', async () => {
    const fail = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '3600' } }));
    const t = createTransport({ url: 'https://in.test/v2/batch', token: 'ct', fetch: fail as unknown as typeof fetch, count: () => {} });
    t.push(ev(1), ctx());
    t.flush();
    await drain();
    expect(fail).toHaveBeenCalledTimes(1);
    t.push(ev(2), ctx());
    hidden(true);
    t.hide();
    t.unload();
    await drain();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('a plain backoff still lets hide try one batch', async () => {
    status = 503;
    const t = make();
    t.push(ev(1), ctx());
    t.flush();
    await drain();
    expect(calls).toHaveLength(1);
    t.push(ev(2), ctx());
    t.hide();
    await drain();
    expect(calls).toHaveLength(2);
  });

  it('drops a batch the request budget refused, never retrying it', async () => {
    const refuse = vi.fn(async () => {
      throw Object.assign(new Error('request budget'), { name: 'SqBudget' });
    });
    const t = createTransport({ url: 'https://in.test/v2/batch', token: 'ct', fetch: refuse as unknown as typeof fetch, count: (name) => (counts[name] = (counts[name] ?? 0) + 1) });
    t.push(ev(1), ctx());
    t.flush();
    await drain();
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS * 2);
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(t.size).toBe(0);
  });

  it('drops a batch on another 4xx and carries on', async () => {
    status = 413;
    const t = make();
    t.push(ev(1), ctx());
    t.flush();
    await drain();
    expect(t.stopped).toBe(false);
    expect(counts.rejected_batch).toBe(1);
  });
});

describe('page lifecycle', () => {
  it('pagehide sends the tail uncompressed with keepalive, within the 64 KB keepalive budget', async () => {
    const t = make();
    for (let i = 0; i < 30; i++) t.push(ev(i, { pad: 'y'.repeat(4000) }), ctx());
    t.unload();
    await drain();
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.gzip).toBe(false);
    expect((c.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(c.init.keepalive).toBe(true);
    expect(String(c.init.body).length).toBeLessThanOrEqual(60_000);
    // What the budget cannot carry is dropped and counted, never sent as a request the unload cancels.
    expect(c.body.events.length + counts.oversized_tail).toBe(30);
  });

  it('counts what the keepalive budget cannot carry', async () => {
    const t = make();
    t.push(ev(1, { pad: 'z'.repeat(70_000) }), ctx());
    t.push(ev(2), ctx());
    t.unload();
    await drain();
    expect(counts.oversized_tail).toBe(1);
    expect(calls.flatMap((c) => c.body.events.map((e) => e.n))).toEqual([2]);
  });

  it('anything queued after pagehide goes out at once', async () => {
    const t = make();
    t.unload();
    t.push(ev(9), ctx());
    await drain();
    expect(calls.map((c) => c.body.events[0].n)).toEqual([9]);
  });

  it('spaces sends while hidden, so a hidden tab cannot loop', async () => {
    const t = make();
    hidden(true);
    t.push(ev(1), ctx());
    t.hide();
    await drain();
    for (let i = 0; i < 20; i++) {
      t.push(ev(i), ctx());
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(calls.length).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(HIDDEN_SPACING_MS);
    await drain();
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});

describe('consent', () => {
  it('holds events while pending, at most 200, then sends on release', async () => {
    const t = make();
    t.hold(true);
    for (let i = 0; i < 250; i++) t.push(ev(i), ctx());
    t.hide();
    await drain();
    expect(calls).toEqual([]);
    expect(t.size).toBe(MAX_PENDING);
    t.rekey(ctx('s-granted'));
    t.hold(false);
    await drain();
    expect(calls[0].body.ctx.session_id).toBe('s-granted');
  });

  it('re-keys only events held before consent, never granted ones', async () => {
    const t = make();
    t.hold(true);
    t.push(ev(1), ctx('s-old', 'p1', { consent: 'granted' }));
    t.push(ev(2), ctx('s-mem', 'p1', { consent: 'pending' }));
    t.rekey(ctx('s-new', 'p1', { consent: 'granted' }));
    t.hold(false);
    t.hide();
    await drain();
    expect(calls.map((c) => [c.body.ctx.session_id, c.body.events.map((e) => e.n)])).toEqual([
      ['s-old', [1]],
      ['s-new', [2]],
    ]);
  });

  it('clear drops everything held', () => {
    const t = make();
    t.hold(true);
    t.push(ev(1), ctx());
    t.clear();
    expect(t.size).toBe(0);
  });
});
