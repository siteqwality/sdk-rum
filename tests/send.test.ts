import { describe, it, expect, vi, afterEach } from 'vitest';
import { send, isRefused, parseRetryAfter, Backoff, BACKOFF_BASE_MS, BACKOFF_MAX_MS, RETRY_AFTER_MAX_MS, keepaliveFits, gzip } from '../src/core/send';
import { budgetError } from '../src/core/budget';
import { byteLength } from '../src/core/util';

const sendJson = (url: string, token: string, body: string) =>
  send(globalThis.fetch, url, token, body, 'application/json', byteLength(body));

function response(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sendJson outcome', () => {
  it.each([200, 202, 204])('reports %i as ok', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status)));
    await expect(sendJson('https://rum.example.com/v1/events', 't', '[]')).resolves.toEqual({
      kind: 'ok',
    });
  });

  it.each([429, 408, 500, 502, 503, 504])('reports %i as retryable', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status)));
    const outcome = await sendJson('https://rum.example.com/v1/events', 't', '[]');
    expect(outcome.kind).toBe('retryable');
  });

  it.each([400, 401, 403, 404, 413])('reports %i as permanent', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status)));
    await expect(sendJson('https://rum.example.com/v1/events', 't', '[]')).resolves.toEqual({
      kind: 'permanent',
      status,
    });
  });

  it('reports a network error as retryable, without rejecting', async () => {
    // Includes an API Gateway error response without CORS headers, which the
    // browser surfaces as a TypeError rather than as its status.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(sendJson('https://rum.example.com/v1/events', 't', '[]')).resolves.toEqual({
      kind: 'retryable',
    });
  });

  it('reports a fetch that throws synchronously as retryable', async () => {
    vi.stubGlobal('fetch', () => {
      throw new TypeError('fetch is not a function');
    });
    await expect(sendJson('https://rum.example.com/v1/events', 't', '[]')).resolves.toEqual({
      kind: 'retryable',
    });
  });

  it('carries Retry-After on a retryable response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(429, { 'Retry-After': '7' })),
    );
    await expect(sendJson('https://rum.example.com/v1/events', 't', '[]')).resolves.toEqual({
      kind: 'retryable',
      retryAfterMs: 7000,
    });
  });

  it('treats only 401 and 403 as a refusal that stops sending', () => {
    expect(isRefused({ kind: 'permanent', status: 401 })).toBe(true);
    expect(isRefused({ kind: 'permanent', status: 403 })).toBe(true);
    expect(isRefused({ kind: 'permanent', status: 400 })).toBe(false);
    expect(isRefused({ kind: 'permanent', status: 413 })).toBe(false);
    expect(isRefused({ kind: 'retryable' })).toBe(false);
    expect(isRefused({ kind: 'ok' })).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');

  it('reads delay seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
  });

  it('reads an HTTP-date', () => {
    expect(parseRetryAfter('Fri, 02 Oct 2026 12:00:45 GMT', now)).toBe(45_000);
  });

  it('treats a date in the past as now', () => {
    expect(parseRetryAfter('Fri, 02 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('ignores a missing or unreadable header', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});

describe('Backoff', () => {
  it('doubles the ceiling per failure from 2s, up to 5 minutes, with full jitter', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const backoff = new Backoff();
    const waits = Array.from({ length: 12 }, () => Math.round(backoff.next()));

    expect(waits.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    expect(waits[waits.length - 1]).toBe(BACKOFF_MAX_MS);

    random.mockReturnValue(0);
    expect(backoff.next()).toBe(0);
  });

  it('starts over after reset', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const backoff = new Backoff();
    backoff.next();
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(Math.round(backoff.next())).toBe(BACKOFF_BASE_MS);
  });

  it('waits at least Retry-After, honoured up to a day', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(new Backoff().next(30_000)).toBe(30_000);
    expect(new Backoff().next(0)).toBe(BACKOFF_BASE_MS / 2);
    expect(new Backoff().next(2 * 3_600_000)).toBe(2 * 3_600_000);
    expect(new Backoff().next(48 * 3_600_000)).toBe(RETRY_AFTER_MAX_MS);
  });

  it('a request the budget refused is permanent, never retried', async () => {
    const refuse = vi.fn().mockRejectedValue(budgetError());
    expect(await send(refuse as unknown as typeof fetch, 'https://in.test/v2/batch', 't', '{}', 'application/json', 2)).toEqual({ kind: 'permanent', status: 0 });
  });
});

describe('byteLength', () => {
  it('counts UTF-8 bytes like TextEncoder', () => {
    const encoder = new TextEncoder();
    for (const text of ['', 'abc', 'é', '\u07ff\u0800', '日本語', '😀 ok', JSON.stringify('\ud800')]) {
      expect(byteLength(text)).toBe(encoder.encode(text).length);
    }
  });
});

describe('send', () => {
  it('posts with the token, the content type, keepalive within budget and no credentials', async () => {
    const f = vi.fn().mockResolvedValue(response(202));
    await send(f as unknown as typeof fetch, 'https://in.test/v2/batch', 'ct', '{}', 'application/json', 2);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://in.test/v2/batch');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ct' } });
  });

  it('adds index headers without allowing case-insensitive auth or content-type overrides', async () => {
    const f = vi.fn().mockResolvedValue(response(202));
    await send(f as unknown as typeof fetch, 'https://in.test/v2/segments', 'ct', '[]', 'application/json', 2, {
      'x-sq-replay-index': 's=session&q=0',
      authorization: 'Bearer wrong',
      AUTHORIZATION: 'Bearer also-wrong',
      'content-TYPE': 'text/plain',
    });
    const headers = new Headers(f.mock.calls[0][1].headers);
    expect(headers.get('authorization')).toBe('Bearer ct');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-sq-replay-index')).toBe('s=session&q=0');
  });

  it('shares one keepalive budget across requests in flight', async () => {
    const releases: Array<(r: unknown) => void> = [];
    const f = vi.fn(() => new Promise((r) => releases.push(r)));
    const first = send(f as unknown as typeof fetch, 'u', 't', 'x', 'application/json', 50_000);
    expect(keepaliveFits(20_000)).toBe(false);
    const second = send(f as unknown as typeof fetch, 'u', 't', 'x', 'application/json', 20_000);
    expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].keepalive).toBe(false);
    for (const r of releases) r(response(202));
    await Promise.all([first, second]);
    expect(keepaliveFits(20_000)).toBe(true);
  });
});

describe('gzip', () => {
  it('compresses with CompressionStream', async () => {
    const text = JSON.stringify({ a: 'x'.repeat(5000) });
    const blob = (await gzip(text))!;
    expect(blob.size).toBeLessThan(200);
    const back = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    expect(back).toBe(text);
  });
});
