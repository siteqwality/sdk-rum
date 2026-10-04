// fetch and XHR (design 5.6, B11): method, minimised URL, status, error kind and timing phases
// from resource timing. Failures are Observe, successes Analyze; repeats of either fold per 30 s.
import type { SqEvent } from '../types';
import { OBSERVE, ANALYZE, type Hub } from '../hub';
import { uuid, randomBytes, toHex } from '../core/hash';
import { redactBody, allowedHeaders } from '../core/sanitize';
import { timing, createExclusionMatcher } from './resources';
import { now, perfNow, round, byteLength, pct, read } from '../core/util';

const JOIN_WAIT_MS = 5_000;
const AGGREGATE_MS = 30_000;
const MAX_PENDING = 100;
/** A response body read gives up after this, so a long stream never holds its row. */
const BODY_WAIT_MS = 10_000;

interface Req {
  method: string;
  url: string;
  start: number;
  t: number;
  initiator: 'fetch' | 'xhr';
  view: string;
  reqHeaders?: Headers;
  reqBody?: string;
  reqBytes?: number;
  trace?: [string, string];
  body: boolean;
  /** The response body read gave up at BODY_WAIT_MS. */
  partial?: boolean;
  done?: () => void;
}

type Row = SqEvent & { url: string; status: number; duration_ms: number; res_bytes?: number };

export interface NetworkOptions {
  /** Holds the route-change loading time open while the request runs. */
  netStart: () => (() => void) | undefined;
  /** A failed request: rule input and breadcrumb. */
  failed: (row: Row) => void;
}

export type Network = ReturnType<typeof startNetwork>;


function absolute(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

function bodySize(body: unknown): number | undefined {
  if (typeof body === 'string') return byteLength(body);
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return byteLength(body.toString());
  return undefined;
}

export function startNetwork(h: Hub, o: NetworkOptions) {
  let cfgRef: unknown;
  let traceMatch: (u: string) => boolean = () => false;
  let bodyMatch: (u: string) => boolean = () => false;
  let headerNames: string[] = [];
  const matchers = () => {
    const net = h.cfg().capture.network;
    if (net !== cfgRef) {
      cfgRef = net;
      // URL prefixes, never patterns (core-rs resource exclusion rules): "/api" is a same-origin
      // path and below, "https://api.example.com/v1" that origin and path. No rules, no matches.
      traceMatch = createExclusionMatcher(net.trace_urls);
      bodyMatch = createExclusionMatcher(net.body_urls);
      headerNames = allowedHeaders(net.header_allowlist);
    }
    return net;
  };

  // Successes wait for their resource timing entry, at most JOIN_WAIT_MS.
  const waiting: Array<{ req: Req; row: Row; timer: ReturnType<typeof setTimeout> }> = [];
  const used = new WeakSet<PerformanceEntry>();

  const phases = (e: PerformanceResourceTiming): Record<string, number | undefined> => ({
    ...timing(e),
    res_bytes: e.encodedBodySize > 0 ? e.encodedBodySize : undefined,
  });

  function matches(req: Req, e: PerformanceResourceTiming): boolean {
    return (
      !used.has(e) &&
      (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') &&
      e.name === req.url &&
      e.startTime >= req.start - 5
    );
  }

  // Entries that arrived before their request settled, newest last.
  const early: PerformanceResourceTiming[] = [];

  /** Timing phases onto the row; the response size the page saw wins. */
  function join(row: Row, e: PerformanceResourceTiming): void {
    used.add(e);
    for (const [k, v] of Object.entries(phases(e))) if (v !== undefined && (k !== 'res_bytes' || !row.res_bytes)) row[k] = v;
  }

  function joinNow(req: Req, row: Row): boolean {
    const entries = read(() => performance.getEntriesByName(req.url, 'resource')) as PerformanceResourceTiming[] | undefined;
    const e = early.find((x) => matches(req, x)) ?? entries?.find((x) => matches(req, x));
    if (e) join(row, e);
    return !!e;
  }

  // Repeats of one request and outcome: the first per view alone, the rest per 30 s (failures
  // too, so a page polling a failing endpoint costs one row per 30 s).
  let seenView = '';
  const seen = new Set<string>();
  const buckets = new Map<string, { row: Row; n: number; d: number[]; bytes: number; failed: boolean }>();
  let bucketTimer: ReturnType<typeof setTimeout> | null = null;

  function flushBuckets(): void {
    if (bucketTimer) clearTimeout(bucketTimer);
    bucketTimer = null;
    for (const { row, n, d, bytes, failed } of buckets.values()) {
      const p50 = round(pct(d, 0.5));
      h.emit(
        {
          k: 'network',
          t: row.t,
          view_id: row.view_id,
          id: uuid(),
          method: row.method,
          url: row.url,
          status: row.status,
          ...(row.error_kind ? { error_kind: row.error_kind } : {}),
          initiator: row.initiator,
          duration_ms: p50,
          ...(bytes ? { res_bytes: bytes } : {}),
          n,
          p50_ms: p50,
          p95_ms: round(pct(d, 0.95)),
          ...(failed ? { err_n: n } : {}),
        },
        failed ? OBSERVE : ANALYZE,
        { kind: 'network' },
      );
    }
    buckets.clear();
  }

  function success(row: Row, failed = false): void {
    if (row.view_id !== seenView) {
      flushBuckets();
      seen.clear();
      seenView = String(row.view_id);
    }
    const key = `${row.method} ${row.url} ${row.status} ${row.error_kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      h.emit(row, failed ? OBSERVE : ANALYZE, { kind: 'network' });
      if (failed) o.failed(row);
      return;
    }
    let b = buckets.get(key);
    if (!b) {
      b = { row, n: 0, d: [], bytes: 0, failed };
      buckets.set(key, b);
      if (!bucketTimer) bucketTimer = setTimeout(flushBuckets, AGGREGATE_MS);
    }
    b.n++;
    if (b.d.length < 1000) b.d.push(row.duration_ms);
    b.bytes += row.res_bytes ?? 0;
  }

  function begin(method: unknown, url: unknown, initiator: Req['initiator'], headers?: Headers): Req | null {
    if (typeof url !== 'string' || !url) return null;
    const abs = absolute(url);
    if (h.isOwn(abs)) return null;
    const net = matchers();
    const clean = h.url(abs);
    const req: Req = {
      method: String(method || 'GET').toUpperCase(),
      url: abs,
      start: perfNow(),
      t: now(),
      initiator,
      view: h.viewId(),
      reqHeaders: headers,
      body: net.max_body_bytes > 0 && bodyMatch(clean),
      done: o.netStart(),
    };
    if (traceMatch(clean)) req.trace = [toHex(randomBytes(16)), toHex(randomBytes(8))];
    return req;
  }

  const pick = (get: (name: string) => string | null | undefined) => {
    const out: Record<string, string> = {};
    for (const name of headerNames) {
      const v = read(() => get(name));
      if (typeof v === 'string') out[name] = h.scrub(v.slice(0, 256));
    }
    return Object.keys(out).length ? out : undefined;
  };

  function complete(req: Req, status: number, kind: string | undefined, resHeaders: ((n: string) => string | null) | undefined, resBody: Promise<string | undefined>): void {
    req.done?.();
    const max = h.cfg().capture.network.max_body_bytes;
    void resBody.then((text) => {
      const row: Row = {
        k: 'network',
        t: req.t,
        view_id: req.view,
        id: uuid(),
        method: req.method,
        url: h.url(req.url),
        status,
        ...(kind ? { error_kind: kind } : {}),
        initiator: req.initiator,
        duration_ms: round(perfNow() - req.start),
        ...(req.reqBytes !== undefined ? { req_bytes: req.reqBytes } : {}),
        ...(req.trace ? { trace_id: req.trace[0], span_id: req.trace[1] } : {}),
      };
      const reqH = req.reqHeaders && pick((n) => req.reqHeaders!.get(n));
      const resH = resHeaders && pick(resHeaders);
      if (reqH) row.req_headers = reqH;
      if (resH) row.res_headers = resH;
      let truncated = false;
      for (const [field, value] of [['req_body', req.reqBody], ['res_body', text]] as const) {
        if (!value) continue;
        const r = redactBody(value, max, h.scrub);
        row[field] = r.body;
        truncated ||= !!r.truncated;
      }
      if (truncated || req.partial) row.truncated = true;
      if (status === 0 || status >= 400) {
        joinNow(req, row);
        success(row, true);
      } else if (!joinNow(req, row)) {
        if (waiting.length >= MAX_PENDING) success(waiting.shift()!.row);
        const w = { req, row, timer: setTimeout(() => settleWaiting(w), JOIN_WAIT_MS) };
        waiting.push(w);
      } else success(row);
    });
  }

  function settleWaiting(w: (typeof waiting)[number]): void {
    const i = waiting.indexOf(w);
    if (i < 0) return;
    waiting.splice(i, 1);
    clearTimeout(w.timer);
    success(w.row);
  }

  function readBody(req: Req, get: () => Promise<string | undefined> | string | undefined): Promise<string | undefined> {
    if (!req.body) return Promise.resolve(undefined);
    try {
      return Promise.resolve(get()).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  // Event streams never end, so they are never read.
  const textual = (type: string | null | undefined) => !!type && /json|xml|form-urlencoded|text\/(?!event-stream)/i.test(type);

  /** At most `max_body_bytes` (and a little) of a fetch response, then the copy is cancelled. */
  async function head(res: Response, req: Req): Promise<string | undefined> {
    const reader = textual(res.headers.get('content-type')) ? res.clone().body?.getReader() : undefined;
    if (!reader) return undefined;
    const max = h.cfg().capture.network.max_body_bytes;
    const dec = new TextDecoder();
    const timer = setTimeout(() => {
      req.partial = true;
      void reader.cancel().catch(() => {});
    }, BODY_WAIT_MS);
    let out = '';
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        out += dec.decode(r.value, { stream: true });
        if (out.length > max) break;
      }
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
    return out;
  }

  // fetch
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      let req: Req | null = null;
      let args: [RequestInfo | URL, RequestInit | undefined] = [input, init];
      try {
        const isReq = typeof Request === 'function' && input instanceof Request;
        const url = isReq ? (input as Request).url : String(input instanceof URL ? input.href : input);
        const source = init?.headers ?? (isReq ? (input as Request).headers : undefined);
        const headers = new Headers(source);
        req = begin(init?.method ?? (isReq ? (input as Request).method : 'GET'), url, 'fetch', headers);
        if (req) {
          req.reqBytes = bodySize(init?.body);
          if (req.body && typeof init?.body === 'string') req.reqBody = init.body;
          if (req.trace && !headers.has('traceparent')) {
            headers.set('traceparent', `00-${req.trace[0]}-${req.trace[1]}-01`);
            args = [input, { ...init, headers }];
          } else if (req.trace) req.trace = undefined;
        }
      } catch {
        req = null;
        args = [input, init];
      }
      const p = nativeFetch.apply(this, args as Parameters<typeof fetch>);
      if (req) {
        const r = req;
        p.then(
          (res) => {
            try {
              complete(r, res.status, undefined, (n) => res.headers.get(n), readBody(r, () => head(res, r)));
            } catch {
              // Monitoring must never break the host page.
            }
          },
          (err) => {
            try {
              const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
              const name = signal?.aborted ? read(() => (signal.reason as Error)?.name) || 'AbortError' : read(() => (err as Error).name);
              complete(r, 0, name === 'TimeoutError' ? 'timeout' : name === 'AbortError' || signal?.aborted ? 'abort' : 'network', undefined, Promise.resolve(undefined));
            } catch {
              // Monitoring must never break the host page.
            }
          },
        );
      }
      return p;
    } as typeof fetch;
  }

  // XMLHttpRequest
  if (typeof XMLHttpRequest === 'function') {
    const P = XMLHttpRequest.prototype;
    const reqs = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Headers }>();
    const { open, send, setRequestHeader } = P;
    P.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
      try {
        reqs.set(this, { method, url: String(url), headers: new Headers() });
      } catch {
        // Monitoring must never break the host page.
      }
      // eslint-disable-next-line prefer-rest-params
      return open.apply(this, arguments as unknown as Parameters<typeof open>);
    } as typeof open;
    P.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      try {
        reqs.get(this)?.headers.append(name, value);
      } catch {
        // Invalid header names throw in setRequestHeader below, as they would anyway.
      }
      return setRequestHeader.call(this, name, value);
    };
    P.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        const info = reqs.get(this);
        const req = info && begin(info.method, info.url, 'xhr', info.headers);
        if (req) {
          req.reqBytes = bodySize(body);
          if (req.body && typeof body === 'string') req.reqBody = body;
          if (req.trace && !info.headers.has('traceparent')) setRequestHeader.call(this, 'traceparent', `00-${req.trace[0]}-${req.trace[1]}-01`);
          else req.trace = undefined;
          let kind: string | undefined;
          const xhr = this;
          for (const type of ['abort', 'timeout', 'error'] as const) {
            xhr.addEventListener(type, () => (kind = type === 'error' ? 'network' : type));
          }
          xhr.addEventListener('loadend', () => {
            try {
              const status = kind ? 0 : xhr.status;
              const text = () => {
                if (!textual(xhr.getResponseHeader('content-type'))) return undefined;
                if (xhr.responseType === '' || xhr.responseType === 'text') return xhr.responseText;
                if (xhr.responseType === 'json') return JSON.stringify(xhr.response);
                return undefined;
              };
              complete(req, status, status === 0 ? kind || 'network' : undefined, (n) => xhr.getResponseHeader(n), readBody(req, text));
            } catch {
              // Monitoring must never break the host page.
            }
          });
        }
      } catch {
        // Monitoring must never break the host page.
      }
      return send.call(this, body);
    };
  }

  return {
    /** A resource timing entry for fetch or XHR. */
    entry(e: PerformanceResourceTiming): void {
      for (const w of [...waiting]) {
        if (matches(w.req, e)) {
          join(w.row, e);
          settleWaiting(w);
          return;
        }
      }
      if (early.push(e) > 50) early.shift();
    },
    /** Hide or a new view: everything waiting and aggregated goes out. */
    flush(): void {
      for (const w of [...waiting]) settleWaiting(w);
      flushBuckets();
    },
  };
}
