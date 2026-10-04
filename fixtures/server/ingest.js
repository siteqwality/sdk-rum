// Mock RUM intake: records every request the SDK makes and answers like production.
// 1.x routes mirror rum-ingestor and replay-ingestor on master; 2.0 routes follow design doc 6.2 to 6.4.
import zlib from 'node:zlib';
import { readBody, send } from './http.js';
import { DEFAULT_SPEC, v1Config, v2Config } from './app-config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TYPES = {
  uuid: (v) => typeof v === 'string' && UUID.test(v),
  num: (v) => typeof v === 'number' && Number.isFinite(v),
  str: (v) => typeof v === 'string',
  u32: (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff,
  u64: (v) => Number.isInteger(v) && v >= 0,
  strMap: (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'),
};

// Field types of the serde structs in rum-ingestor/src/handlers/mod.rs (master).
// Option<T> accepts null; a #[serde(default)] map does not.
const V1_SHAPES = {
  measure: {
    required: { session_id: 'uuid', view_id: 'uuid', timestamp: 'num', type: 'str', url: 'str' },
    optional: {
      lcp_ms: 'num', fcp_ms: 'num', cls: 'num', inp_ms: 'num', ttfb_ms: 'num', load_time_ms: 'num',
      dom_ready_ms: 'num', error_count: 'u32', action_count: 'u32', resource_count: 'u32',
      user_agent: 'str', country: 'str', device_type: 'str', browser: 'str', os: 'str',
      user_id: 'str', user_email: 'str',
    },
  },
  events: {
    required: { session_id: 'uuid', view_id: 'uuid', event_id: 'uuid', timestamp: 'num', type: 'str', url: 'str' },
    optional: {
      resource_type: 'str', resource_url: 'str', duration_ms: 'num', transfer_size: 'u64',
      error_message: 'str', error_source: 'str', error_stack: 'str', action_type: 'str',
      action_target: 'str', frustration: 'str', long_task_duration_ms: 'num', user_id: 'str', user_email: 'str',
    },
    maps: { custom_attributes: 'strMap' },
  },
  errors: {
    required: {
      session_id: 'uuid', view_id: 'uuid', event_id: 'uuid', timestamp: 'num', url: 'str',
      error_message: 'str', error_source: 'str', error_stack: 'str',
    },
    optional: { version: 'str', user_id: 'str', user_email: 'str' },
    maps: { custom_attributes: 'strMap' },
  },
};

// Event kinds of the 2.0 batch (design doc 6.3).
const V2_KINDS = new Set([
  'view_start', 'view_end', 'error', 'custom', 'action', 'network', 'resource', 'console', 'long_frame', 'status',
]);

function checkShape(item, shape, where) {
  const problems = [];
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return [`${where}: not an object`];
  for (const [k, t] of Object.entries(shape.required)) {
    if (!TYPES[t](item[k])) problems.push(`${where}.${k}: expected ${t}, got ${JSON.stringify(item[k])?.slice(0, 60)}`);
  }
  for (const [k, t] of Object.entries(shape.optional || {})) {
    if (item[k] !== undefined && item[k] !== null && !TYPES[t](item[k])) {
      problems.push(`${where}.${k}: expected ${t} or null, got ${JSON.stringify(item[k])?.slice(0, 60)}`);
    }
  }
  for (const [k, t] of Object.entries(shape.maps || {})) {
    if (item[k] !== undefined && !TYPES[t](item[k])) problems.push(`${where}.${k}: expected ${t}`);
  }
  return problems;
}

const RRWEB_FULL_SNAPSHOT = 2;
const RRWEB_META = 4;

function rrwebStats(events) {
  let fullSnapshots = 0;
  let metas = 0;
  for (const e of events) {
    if (e?.type === RRWEB_FULL_SNAPSHOT) fullSnapshots++;
    if (e?.type === RRWEB_META) metas++;
  }
  return { events: events.length, fullSnapshots, metas };
}

const bearer = (headers) => /^Bearer (.+)$/i.exec(headers.authorization || '')?.[1] ?? null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Retry-After',
};

export class MockIngest {
  constructor() {
    this.reset();
    this.apps = new Map();
    this.appsById = new Map();
  }

  reset() {
    this.records = [];
    this.seq = 0;
    this.faults = [];
    this.lastAt = new Map();
    this.segmentKeys = new Map();
  }

  register(token, applicationId, spec = {}) {
    const full = { ...DEFAULT_SPEC, ...spec };
    const app = {
      token,
      applicationId,
      spec: full,
      v1: v1Config(applicationId, full),
      v2: v2Config(applicationId, full),
    };
    this.apps.set(token, app);
    this.appsById.set(applicationId, app);
    return app;
  }

  touch(token) {
    const now = Date.now();
    this.lastAt.set(token ?? '*', now);
    this.lastAt.set('*', now);
  }

  quietFor(token) {
    const last = this.lastAt.get(token ?? '*');
    return last === undefined ? Infinity : Date.now() - last;
  }

  record(entry) {
    const rec = { seq: ++this.seq, at: Date.now(), problems: [], ...entry };
    this.records.push(rec);
    this.touch(rec.token);
    return rec;
  }

  takeFault(path) {
    const fault = this.faults.find((f) => f.times > 0 && path.startsWith(f.path));
    if (!fault) return null;
    fault.times--;
    return fault;
  }

  // Requests to the ingest and replay hosts.
  async handle(host, req, res, url) {
    const headers = req.headers;
    const token = bearer(headers);
    const base = {
      host,
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      url: url.href,
      headers,
      token,
    };

    if (req.method === 'OPTIONS') {
      this.record({ ...base, kind: 'preflight', status: 204, wireBytes: 0 });
      return send(res, 204, '', {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Max-Age': '7200',
      });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      this.record({ ...base, kind: 'oversized', status: 413, wireBytes: -1 });
      return send(res, err.status || 400, '', CORS);
    }
    const rec = this.record({ ...base, kind: 'unknown', status: 0, wireBytes: raw.length });
    this.decode(rec, raw, headers);

    const fault = this.takeFault(url.pathname);
    if (fault) {
      rec.status = fault.status;
      rec.fault = true;
      return send(res, fault.status, '', { ...CORS, ...(fault.retryAfter ? { 'Retry-After': String(fault.retryAfter) } : {}) });
    }

    const route = `${req.method} ${host} ${url.pathname}`;
    const reply = (status, body = '') => {
      rec.status = status;
      send(res, status, body, CORS);
    };
    if (!token && route !== 'GET ingest /v2/identity') {
      rec.kind = rec.kind === 'unknown' ? 'unauthorized' : rec.kind;
      rec.problems.push('missing Authorization bearer token');
      return reply(401);
    }

    switch (route) {
      case 'GET ingest /v1/config': {
        rec.kind = 'config_v1';
        const app = this.apps.get(token);
        return reply(200, { data: app ? app.v1 : v1Config('00000000-0000-4000-8000-000000000000', DEFAULT_SPEC) });
      }
      case 'POST ingest /v1/measure':
      case 'POST ingest /v1/events':
      case 'POST ingest /v1/errors': {
        const stream = url.pathname.slice(4);
        rec.kind = `${stream}_v1`;
        if (rec.json === undefined) return reply(400);
        if (!Array.isArray(rec.json)) {
          rec.problems.push('body is not a JSON array');
          return reply(422);
        }
        rec.items = rec.json.length;
        rec.json.forEach((item, i) => rec.problems.push(...checkShape(item, V1_SHAPES[stream], `${stream}[${i}]`)));
        return reply(rec.problems.length ? 422 : 202);
      }
      case 'POST replay /v1/segments': {
        rec.kind = 'segment_v1';
        return reply(this.checkSegmentV1(rec));
      }
      case 'POST ingest /v2/batch': {
        rec.kind = 'batch_v2';
        return reply(this.checkBatchV2(rec, raw));
      }
      case 'POST replay /v2/segments': {
        rec.kind = 'segment_v2';
        return reply(this.checkSegmentV2(rec, raw));
      }
      case 'GET ingest /v2/identity': {
        rec.kind = 'identity_v2';
        return reply(200, { record: true });
      }
      default:
        rec.problems.push(`no such route: ${route}`);
        return reply(404);
    }
  }

  decode(rec, raw, headers) {
    let body = raw;
    rec.encoding = 'identity';
    if (raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b) {
      try {
        body = zlib.gunzipSync(raw, { maxOutputLength: 64 * 1024 * 1024 });
        rec.encoding = 'gzip';
      } catch {
        rec.problems.push('gzip body did not inflate');
      }
    } else if (/gzip/i.test(headers['content-encoding'] || '')) {
      rec.problems.push('content-encoding gzip without a gzip body');
    }
    rec.bodyBytes = body.length;
    rec.gzipBytes = body.length ? zlib.gzipSync(body).length : 0;
    rec.bodyText = body.toString('utf8');
    if (rec.bodyText.length) {
      try {
        rec.json = JSON.parse(rec.bodyText);
      } catch {
        rec.json = undefined;
        rec.problems.push('body is not valid JSON');
      }
    }
  }

  checkSegmentV1(rec) {
    const { session_id: sid, segment_index: idx } = rec.query;
    if (!UUID.test(sid || '')) rec.problems.push('query session_id is not a UUID');
    if (!/^\d+$/.test(idx || '') || Number(idx) > 0xffffffff) rec.problems.push('query segment_index is not a u32');
    const body = rec.json;
    if (!body || !Array.isArray(body.events)) {
      rec.problems.push('body has no events array');
      return 400;
    }
    if (body.session_id !== sid) rec.problems.push('body session_id differs from the query');
    if (String(body.segment_index) !== idx) rec.problems.push('body segment_index differs from the query');
    if (body.events.length === 0) rec.problems.push('segment has no events');
    rec.segment = { sessionId: sid, index: Number(idx), ...rrwebStats(body.events) };
    return rec.problems.length ? 400 : 202;
  }

  checkBatchV2(rec, raw) {
    if (raw.length > 1024 * 1024 || rec.bodyBytes > 8 * 1024 * 1024) return 413;
    const b = rec.json;
    if (!b || b.v !== 2 || !b.ctx || typeof b.ctx.session_id !== 'string' || !Array.isArray(b.events)) {
      rec.problems.push('batch is not {v: 2, ctx.session_id, events[]}');
      return 400;
    }
    if (b.events.length > 500) rec.problems.push('batch has more than 500 events');
    rec.items = b.events.length;
    b.events.forEach((e, i) => {
      if (!V2_KINDS.has(e?.k)) rec.problems.push(`events[${i}].k: unknown kind ${JSON.stringify(e?.k)}`);
      if (!TYPES.num(e?.t)) rec.problems.push(`events[${i}].t: expected epoch ms`);
    });
    return 202;
  }

  // Design 6.4, strictly: every index field, and each one agreeing with the body.
  checkSegmentV2(rec, raw) {
    if (raw.length > 2 * 1024 * 1024 || rec.bodyBytes > 16 * 1024 * 1024) return 413;
    const q = rec.query;
    for (const k of ['s', 'w', 'p', 'q', 'ft', 'lt', 'n', 'v']) if (q[k] === undefined) rec.problems.push(`query ${k} missing`);
    for (const k of ['s', 'w', 'p']) if (q[k] !== undefined && !UUID.test(q[k])) rec.problems.push(`query ${k} is not a UUID`);
    if (!/^\d+$/.test(q.q || '') || Number(q.q) > 0xffffffff) rec.problems.push('query q is not a u32');
    for (const k of ['fs', 'fin']) if (q[k] !== undefined && q[k] !== '1') rec.problems.push(`query ${k} is neither 1 nor absent`);
    if (q.r !== undefined && !q.r) rec.problems.push('query r is empty');
    if (q.v !== undefined && !/^\d+\.\d+\.\d+$/.test(q.v)) rec.problems.push('query v is not an SDK version');
    const type = rec.headers['content-type'] || '';
    if (rec.encoding === 'gzip' ? type !== 'application/octet-stream' : type !== 'application/json') rec.problems.push(`content-type ${type} for a ${rec.encoding} body`);
    const events = rec.json;
    if (!Array.isArray(events) || events.length === 0) {
      rec.problems.push('body is not a non-empty JSON array of rrweb events');
      return 400;
    }
    const stats = rrwebStats(events);
    const ts = events.map((e) => e?.timestamp);
    if (Number(q.n) !== events.length) rec.problems.push(`query n=${q.n} but ${events.length} events`);
    if (Number(q.ft) !== Math.min(...ts) || Number(q.lt) !== Math.max(...ts)) rec.problems.push(`query ft..lt ${q.ft}..${q.lt} but events span ${Math.min(...ts)}..${Math.max(...ts)}`);
    if ((q.fs === '1') !== stats.fullSnapshots > 0) rec.problems.push('query fs disagrees with the events');
    if (q.q === '0' && events[0]?.type !== RRWEB_META) rec.problems.push('a page load does not open with a Meta event');
    // The intake dedupes a retried body; the same key with other content is a numbering bug.
    const key = `${q.s}|${q.w}|${q.p}|${q.q}`;
    const seen = this.segmentKeys.get(key);
    if (seen !== undefined && seen !== rec.bodyText) rec.problems.push(`segment ${key} sent twice with different events`);
    this.segmentKeys.set(key, rec.bodyText);
    rec.segment = { sessionId: q.s, windowId: q.w, pageLoadId: q.p, index: Number(q.q), final: q.fin === '1', rule: q.r, version: q.v, ...stats };
    return 202;
  }

  // GET rum/config/v2/<app>.json on the CDN host.
  config2(applicationId) {
    return this.appsById.get(applicationId)?.v2 ?? null;
  }

  // Control API, served on the ingest host under /__mock.
  async control(req, res, url) {
    const p = url.pathname.slice('/__mock'.length);
    const token = url.searchParams.get('token');
    const mine = (r) => !token || r.token === token || (r.kind === 'preflight' && token !== null) || r.host === 'cdn';
    if (req.method === 'POST' && p === '/reset') {
      this.reset();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && p.startsWith('/apps/')) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const app = this.register(decodeURIComponent(p.slice('/apps/'.length)), body.applicationId, body.spec);
      return send(res, 200, app);
    }
    if (req.method === 'PUT' && p === '/faults') {
      this.faults = JSON.parse((await readBody(req)).toString('utf8') || '[]');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/records') {
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, this.records.filter((r) => r.seq > since && mine(r)));
    }
    if (req.method === 'GET' && p === '/summary') {
      return send(res, 200, this.records.filter(mine).map(({ bodyText, json, headers, ...meta }) => meta));
    }
    if (req.method === 'GET' && p === '/quiet') {
      const ms = Number(url.searchParams.get('ms') || 1000);
      const deadline = Date.now() + Number(url.searchParams.get('timeout') || 20000);
      while (this.quietFor(token) < ms && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return send(res, 200, { quiet: this.quietFor(token) >= ms });
    }
    return send(res, 404, { error: 'no such control route' });
  }
}
