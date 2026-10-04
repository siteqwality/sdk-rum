import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SiteQwalityRUM } from '../src/sdk';
import { boot, clearStorage, config, flush, rule, settle, stubNetwork, type Net } from './helpers/sdk';
import { FakePerformanceObserver } from './setup';

const analyze = (extra: Record<string, unknown> = {}) => stubNetwork(config({ rules: [rule('analyze')], ...extra }));

beforeEach(() => clearStorage());
afterEach(() => vi.unstubAllGlobals());

async function run(net: Net, fn: () => Promise<unknown>) {
  await boot({}, net);
  await fn();
  await settle();
  await flush();
  return net.events('network');
}

describe('fetch', () => {
  it('records failures at Observe, without any rule', async () => {
    const net = stubNetwork();
    const rows = await run(net, async () => {
      await fetch('/api/ok');
      await fetch('/api/fail');
      await fetch('/api/drop').catch(() => {});
    });
    expect(rows.map((r) => [r.url, r.status, r.error_kind])).toEqual([
      ['http://localhost:3000/api/fail', 500, undefined],
      ['http://localhost:3000/api/drop', 0, 'network'],
    ]);
    expect(rows[0]).toMatchObject({ method: 'GET', initiator: 'fetch' });
    expect(typeof rows[0].duration_ms).toBe('number');
  });

  it('records successes once Analyze is on, minimised, with request size', async () => {
    const rows = await run(analyze(), () => fetch('/api/search?q=x&api_key=secret', { method: 'post', body: '{"a":1}' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'POST', url: 'http://localhost:3000/api/search', status: 200, req_bytes: 7 });
  });

  it('tells aborts and timeouts from network failures', async () => {
    const net = stubNetwork();
    net.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rum/config/')) return new Response(JSON.stringify(config()));
      if (url.endsWith('/v2/batch')) {
        net.batches.push({ url, headers: {}, gzip: false, body: JSON.parse(typeof init?.body === 'string' ? init.body : await new Response((init!.body as Blob).stream().pipeThrough(new DecompressionStream('gzip'))).text()) });
        return new Response('', { status: 202 });
      }
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    });
    const rows = await run(net, async () => {
      const ctl = new AbortController();
      const a = fetch('/api/slow', { signal: ctl.signal }).catch((e) => e.name);
      ctl.abort();
      const t = fetch('/api/slow', { signal: AbortSignal.timeout(10) }).catch((e) => e.name);
      expect(await a).toBe('AbortError');
      expect(await t).toBe('TimeoutError');
    });
    expect(rows.map((r) => r.error_kind).sort()).toEqual(['abort', 'timeout']);
  });

  it('returns exactly what the page would get, and adds no headers by default', async () => {
    const net = stubNetwork();
    await boot({}, net);
    const res = await fetch('/api/ok', { headers: { 'X-App': '1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const init = net.app.at(-1)!.init!;
    expect(new Headers(init.headers).get('traceparent')).toBeNull();
    expect(new Headers(init.headers).get('x-app')).toBe('1');
  });

  it('never records its own requests', async () => {
    const net = analyze();
    const rows = await run(net, async () => {
      await fetch('https://cdn.test/rum/config/v2/x.json');
      await fetch('https://in.test/v2/identity?h=1');
    });
    expect(rows).toEqual([]);
  });

  it('injects traceparent only for trace_urls and stores the ids on the row', async () => {
    const net = analyze({ capture: { network: { trace_urls: ['http://localhost:3000/api'] } } });
    const rows = await run(net, async () => {
      await fetch('/api/ok');
      await fetch('/other');
    });
    const traced = new Headers(net.app.find((a) => a.url.includes('/api/ok'))!.init!.headers).get('traceparent');
    expect(traced).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(new Headers(net.app.find((a) => a.url.includes('/other'))!.init?.headers).get('traceparent')).toBeNull();
    const row = rows.find((r) => String(r.url).endsWith('/api/ok'))!;
    expect(traced).toBe(`00-${row.trace_id}-${row.span_id}-01`);
  });

  it('keeps an existing traceparent', async () => {
    const net = analyze({ capture: { network: { trace_urls: ['http://localhost:3000/api'] } } });
    const rows = await run(net, () => fetch('/api/ok', { headers: { traceparent: '00-aaaa-bbbb-01' } }));
    expect(new Headers(net.app.at(-1)!.init!.headers).get('traceparent')).toBe('00-aaaa-bbbb-01');
    expect(rows[0].trace_id).toBeUndefined();
  });

  it('captures allowlisted headers only, never credentials', async () => {
    const net = analyze();
    const rows = await run(net, () => fetch('/api/ok', { headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' } }));
    expect(rows[0].req_headers).toEqual({ 'content-type': 'application/json' });
    expect(rows[0].res_headers).toEqual({ 'content-type': 'application/json', 'x-request-id': 'rid-1' });
  });

  it('captures bodies only for body_urls, redacted and scrubbed', async () => {
    const net = analyze({ capture: { network: { body_urls: ['/api/login'], max_body_bytes: 1000 } } });
    const rows = await run(net, async () => {
      await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email: 'j@x.io', password: 'hunter2' }) });
      await fetch('/api/other', { method: 'POST', body: '{"password":"p"}' });
    });
    const login = rows.find((r) => String(r.url).endsWith('/api/login'))!;
    expect(JSON.parse(String(login.req_body))).toEqual({ email: '<email>', password: '[redacted]' });
    expect(login.res_body).toBe('{"ok":true}');
    expect(rows.find((r) => String(r.url).endsWith('/api/other'))!.req_body).toBeUndefined();
  });

  it('aggregates successful repeats per view into one row with count and percentiles', async () => {
    const net = analyze();
    const rows = await run(net, async () => {
      for (let i = 0; i < 12; i++) await fetch('/api/poll');
    });
    const poll = rows.filter((r) => String(r.url).endsWith('/api/poll'));
    expect(poll).toHaveLength(2);
    expect(poll[0].n).toBeUndefined();
    expect(poll[1]).toMatchObject({ n: 11 });
    expect(typeof poll[1].p50_ms).toBe('number');
    expect(typeof poll[1].p95_ms).toBe('number');
  });

  it('joins resource timing phases', async () => {
    const net = analyze();
    const rows = await run(net, async () => {
      const p = fetch('/api/timed');
      FakePerformanceObserver.emit('resource', [
        {
          name: 'http://localhost:3000/api/timed',
          initiatorType: 'fetch',
          startTime: performance.now(),
          duration: 120,
          domainLookupStart: 1,
          domainLookupEnd: 6,
          connectStart: 6,
          connectEnd: 20,
          secureConnectionStart: 10,
          requestStart: 20,
          responseStart: 80,
          responseEnd: 110,
          encodedBodySize: 512,
        },
      ]);
      await p;
    });
    expect(rows[0]).toMatchObject({ duration_ms: 120, dns_ms: 5, connect_ms: 14, tls_ms: 10, ttfb_ms: 60, download_ms: 30, res_bytes: 512 });
  });
});

describe('XMLHttpRequest', () => {
  class FakeXhr extends EventTarget {
    status = 0;
    responseType = '';
    responseText = '';
    response: unknown = '';
    headers: Record<string, string> = {};
    url = '';
    open(_m: string, url: string) {
      this.url = url;
    }
    setRequestHeader(n: string, v: string) {
      this.headers[n.toLowerCase()] = v;
    }
    getResponseHeader(n: string) {
      return n === 'content-type' ? 'application/json' : null;
    }
    send() {
      queueMicrotask(() => {
        if (this.url.includes('drop')) this.dispatchEvent(new Event('error'));
        else if (this.url.includes('slow')) this.dispatchEvent(new Event('timeout'));
        else {
          this.status = this.url.includes('fail') ? 500 : 200;
          this.responseText = '{}';
          this.dispatchEvent(new Event('load'));
        }
        this.dispatchEvent(new Event('loadend'));
      });
    }
  }

  it('records status, failures and timeouts without changing what the page sees', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const net = analyze();
    const seen: number[] = [];
    const rows = await run(net, async () => {
      for (const path of ['/x/ok', '/x/fail', '/x/drop', '/x/slow']) {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', path);
        await new Promise((r) => {
          xhr.addEventListener('loadend', r);
          xhr.send();
        });
        seen.push(xhr.status);
      }
    });
    expect(seen).toEqual([200, 500, 0, 0]);
    expect(rows.map((r) => [String(r.url).replace('http://localhost:3000', ''), r.status, r.error_kind ?? null, r.initiator])).toEqual([
      ['/x/fail', 500, null, 'xhr'],
      ['/x/drop', 0, 'network', 'xhr'],
      ['/x/slow', 0, 'timeout', 'xhr'],
      ['/x/ok', 200, null, 'xhr'],
    ]);
  });
});

describe('rules and breadcrumbs', () => {
  it('a failed request is a rule input and a breadcrumb on the next error', async () => {
    const net = stubNetwork(config({ rules: [rule('analyze', [{ kind: 'network_error', status_class: '5xx' }])] }));
    await boot({}, net);
    await fetch('/api/fail');
    await settle();
    expect(SiteQwalityRUM.getStatus()?.sampled.analyze).toBe(true);
    SiteQwalityRUM.addError(new Error('after'));
    await flush();
    const crumbs = net.events('error')[0].breadcrumbs as Array<{ k: string; msg: string }>;
    expect(crumbs.some((c) => c.k === 'network' && c.msg === 'GET http://localhost:3000/api/fail 500')).toBe(true);
  });
});
