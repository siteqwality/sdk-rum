// One view over what the SDK sent: /v2/batch and /v2/segments.

export const RRWEB = { FULL_SNAPSHOT: 2, INCREMENTAL: 3, META: 4, CUSTOM: 5 };
export const RRWEB_SOURCE = { MUTATION: 0, MOUSE_MOVE: 1, INPUT: 5, CANVAS_MUTATION: 9 };

const SDK_KINDS = new Set(['config_v2', 'batch_v2', 'segment_v2', 'identity_v2', 'unauthorized', 'oversized', 'unknown']);

export class Captures {
  constructor(records) {
    this.records = records;
  }

  // Requests the SDK made, other than CORS preflights and its own script files.
  get requests() {
    return this.records.filter((r) => SDK_KINDS.has(r.kind));
  }

  get preflights() {
    return this.records.filter((r) => r.kind === 'preflight');
  }

  get assets() {
    return this.records.filter((r) => r.kind === 'sdk_asset' && r.status === 200);
  }

  get problems() {
    return this.records.flatMap((r) => (r.problems || []).map((p) => `${r.method} ${r.path} (${r.kind}): ${p}`));
  }

  // Requests the mock refused, other than injected faults.
  get rejected() {
    return this.requests.filter((r) => !r.fault && (r.status < 200 || r.status >= 300));
  }

  // Batch events of kind k, each with the batch ctx attached.
  batch(k) {
    return this.records
      .filter((r) => r.kind === 'batch_v2' && r.json?.events)
      .flatMap((r) => r.json.events.filter((e) => e.k === k).map((e) => ({ ...e, ctx: r.json.ctx })));
  }

  get views() {
    return this.batch('view_start').map((e) => ({ url: e.url, route: e.route, sessionId: e.ctx.session_id, viewId: e.view_id, t: e.t }));
  }

  get vitals() {
    return this.batch('view_end').map((m) => ({ lcp: m.lcp_ms, fcp: m.fcp_ms, cls: m.cls, inp: m.inp_ms, ttfb: m.ttfb_ms }));
  }

  get errors() {
    return this.batch('error').map((e) => ({
      message: e.message, stack: e.stack, handling: e.handling, type: e.error_type, sessionId: e.ctx.session_id, url: e.url ?? null,
      repeat: e.repeat ?? 1, cause: e.cause, raw: e,
    }));
  }

  get actions() {
    return [
      ...this.batch('action').map((e) => ({ type: e.action_type, name: e.name, selector: e.selector, frustration: e.frustration })),
      ...this.batch('custom').map((e) => ({ type: 'custom', name: e.name })),
    ];
  }

  // Subresources from resource timing; fetch and XHR are network rows.
  get resources() {
    return this.batch('resource').map((e) => ({ url: e.url, initiator: e.initiator, durationMs: e.duration_ms, n: e.n }));
  }

  // fetch and XHR calls with status.
  get network() {
    return this.batch('network').map((e) => ({
      url: e.url, method: e.method, status: e.status, errorKind: e.error_kind, initiator: e.initiator, n: e.n ?? 1, traceId: e.trace_id,
    }));
  }

  get console() {
    return this.batch('console').map((e) => ({ level: e.level, message: e.message, repeat: e.repeat ?? 1 }));
  }

  get longTasks() {
    return this.batch('long_frame');
  }

  get sessionIds() {
    return new Set([
      ...this.records.filter((r) => r.kind === 'batch_v2').map((r) => r.json?.ctx?.session_id),
      ...this.segments.map((s) => s.sessionId),
    ].filter(Boolean));
  }

  get segments() {
    return this.records
      .filter((r) => r.kind === 'segment_v2' && r.segment)
      .map((r) => ({
        ...r.segment,
        at: r.at,
        status: r.status,
        wireBytes: r.wireBytes,
        bodyBytes: r.bodyBytes,
        gzipBytes: r.gzipBytes,
        encoding: r.encoding,
        events: r.json,
      }));
  }

  get replayEvents() {
    return this.segments.flatMap((s) => s.events);
  }

  replayEventsOf(type, source) {
    return this.replayEvents.filter((e) => e.type === type && (source === undefined || e.data?.source === source));
  }

  // Bytes the SDK put on the wire (as sent) and what gzip would make of them.
  bytes(filter = () => true) {
    const rs = this.requests.filter(filter);
    return {
      requests: rs.length,
      wire: rs.reduce((a, r) => a + (r.wireBytes || 0), 0),
      raw: rs.reduce((a, r) => a + (r.bodyBytes || 0), 0),
      gzip: rs.reduce((a, r) => a + (r.gzipBytes || 0), 0),
    };
  }

  // Everything an SDK request carried, for the canary grep: URL, headers and decoded body.
  haystacks() {
    return this.records
      .filter((r) => r.kind !== 'sdk_asset')
      .map((r) => ({ record: r, text: `${r.url || r.path}\n${JSON.stringify(r.headers || {})}\n${r.bodyText || ''}` }));
  }
}
