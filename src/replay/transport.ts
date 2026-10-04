// Replay segments to `POST /v2/segments` (design 6.4): index fields in x-sq-replay-index, a gzip JSON
// array of rrweb events as the body, one request in flight, in order, with the core's retry rules.
import { isRefused, Backoff, gzip, KEEPALIVE_MAX_BYTES, type send as coreSend } from '../core/send';
import { byteLength, now } from '../core/util';
import { VERSION } from '../version';
import type { Segment } from './segmenter';
import type { Stream } from './stream';
import { loadGzip } from './gzip-load';

/** The intake takes at most this on the wire. */
export const MAX_WIRE_BYTES = 2 * 1024 * 1024;
/** Segments held while one is in flight or while backing off; past either cap the oldest go. */
export const MAX_BUFFERED_SEGMENTS = 10;
export const MAX_BUFFERED_BYTES = 8_000_000;

export type { Stream };

interface Pending {
  stream: Stream;
  q: number;
  /** First and last event times and the event count, for the index. */
  ft: number;
  lt: number;
  n: number;
  rule?: string;
  /** The last segment of its page load (set at pagehide). */
  fin?: boolean;
  text: string;
  /** The gzip body once ready; null when it could not be compressed. */
  body?: Blob | null;
  zipped: Promise<void>;
  bytes: number;
  fs: boolean;
  css: string[];
}

export interface TransportHooks {
  /** A segment and everything built on its snapshot was lost (the stream must re-snapshot). */
  lost?: (stream: Stream) => void;
  /** A snapshot can never fit the intake: replay stops for the page load. */
  tooLarge?: () => void;
  /** Drop counters for `status`. */
  count?: (name: string, n?: number) => void;
  /** Intake refusal stops capture as well as delivery. */
  refused?: (reason: string) => void;
}

/** gzip, with fflate where CompressionStream is missing; null when neither works. */
async function compress(text: string): Promise<Blob | null> {
  const native = await gzip(text);
  if (native) return native;
  try {
    return await (await loadGzip())(text);
  } catch {
    return null;
  }
}

/**
 * Sends segments one at a time, in order. A retryable failure keeps the segment and backs off
 * (Retry-After holds everything); 401, 403 and the request budget stop delivery; any other 4xx
 * drops the segment. Losing a snapshot drops what built on it, until the next snapshot. Retries
 * resend the same bytes, so the intake's content-addressed write dedupes them.
 */
export class ReplayTransport {
  private queue: Pending[] = [];
  private queued = 0;
  private sending: Promise<void> | null = null;
  private inFlight: Pending | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private quietUntil = 0;
  private backoff = new Backoff();
  private stopped = false;
  private warned = false;
  private lostStream: Stream | null = null;

  constructor(
    private base: string,
    private token: string,
    private fetchFn: typeof fetch,
    private send: typeof coreSend,
    private hooks: TransportHooks = {},
  ) {
    // Replay-specific response reasons stay in the lazy chunk. The core keeps its retry policy.
    this.fetchFn = async (input, init) => {
      const res = await fetchFn(input, init);
      if (res.status === 403 || res.status === 429) {
        try {
          const reason = (await res.json())?.reason;
          if (!this.stopped && ((res.status === 403 && reason === 'not_enabled') || (res.status === 429 && reason === 'session_cap'))) {
            this.stop();
            this.hooks.refused?.(reason);
          }
        } catch {
          // Empty, malformed or unreadable responses retain the status-based policy.
        }
      }
      return res;
    };
  }

  /** Drops everything queued and sends nothing more (consent, opt-out, budget). */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.queued = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  get idle(): boolean {
    return !this.queue.length && !this.inFlight;
  }

  private headers({ stream, q, ft, lt, n, fs, fin, rule }: Pending): Record<string, string> {
    const qs = `s=${stream.s}&w=${stream.w}&p=${stream.p}&q=${q}&ft=${ft}&lt=${lt}&n=${n}${fs ? '&fs=1' : ''}${fin ? '&fin=1' : ''}${rule ? `&r=${encodeURIComponent(rule)}` : ''}&v=${VERSION}`;
    return { 'x-sq-replay-index': qs };
  }

  private pending(stream: Stream, seg: Segment, rule?: string): Pending {
    // Match ingest's optional rule-id grammar; malformed config must not bloat or break headers.
    if (rule && !/^[\w.:-]{1,64}$/.test(rule)) rule = undefined;
    const text = `[${seg.json.join(',')}]`;
    return { stream, q: stream.q++ >>> 0, ft: seg.ft, lt: seg.lt, n: seg.json.length, rule, text, bytes: seg.mem + 2, fs: seg.fs, css: seg.css, zipped: Promise.resolve() };
  }

  /** Queues a closed segment: numbered now, compressed now, sent in order. Never rejects. */
  push(stream: Stream, seg: Segment, rule?: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (seg.fs) {
      if (this.lostStream === stream) this.lostStream = null;
    } else if (this.lostStream === stream) {
      // Built on a snapshot that never arrived: it cannot play.
      this.hooks.count?.('replay_segments_dropped');
      return this.pump();
    }
    const p = this.pending(stream, seg, rule);
    p.zipped = compress(p.text).then((b) => {
      p.body = b;
      if (!b) return;
      // The gzip body is all that is kept; the text goes (stylesheets wait for the ack).
      const bytes = b.size + p.css.reduce((n, c) => n + c.length, 0);
      if (this.queue.includes(p)) this.queued += bytes - p.bytes;
      p.bytes = bytes;
      p.text = '';
    });
    this.queue.push(p);
    this.queued += p.bytes;
    this.trim();
    return this.pump();
  }

  private pump(): Promise<void> {
    if (!this.sending && this.canSend()) this.sending = this.drain();
    return this.sending ?? Promise.resolve();
  }

  private canSend(): boolean {
    return !this.stopped && this.retryTimer === null && this.queue.length > 0 && now() >= this.quietUntil;
  }

  /** Entered only when `canSend()`; one request at a time, in order. */
  private async drain(): Promise<void> {
    do {
      const p = this.queue[0];
      await p.zipped;
      // Stopped, sent at unload, or trimmed while compressing.
      if (this.stopped || this.queue[0] !== p) continue;
      const body = p.body ?? p.text;
      const size = p.body ? p.body.size : byteLength(p.text);
      if (size > MAX_WIRE_BYTES) {
        this.shift();
        this.drop(p, true);
        continue;
      }
      this.inFlight = p;
      const outcome = await this.send(this.fetchFn, `${this.base}/v2/segments`, this.token, body, p.body ? 'application/octet-stream' : 'application/json', size, this.headers(p));
      this.inFlight = null;
      if (this.stopped || this.queue[0] !== p) continue;
      if (outcome.kind === 'ok') {
        this.shift();
        this.backoff.reset();
        p.stream.css.ack(p.css);
      } else if (outcome.kind === 'retryable') {
        const wait = this.backoff.next(outcome.retryAfterMs);
        if (outcome.retryAfterMs) this.quietUntil = now() + wait;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.quietUntil = 0;
          void this.pump();
        }, wait);
      } else if (isRefused(outcome) || outcome.status === 0) {
        // Refused by the intake, or by the request budget: nothing more goes.
        this.stop();
        if (isRefused(outcome)) this.hooks.refused?.('refused');
      } else {
        this.shift();
        this.drop(p, outcome.status === 413);
      }
    } while (this.canSend());
    this.sending = null;
  }

  private shift(): void {
    const p = this.queue.shift();
    if (p) this.queued -= p.bytes;
  }

  /** A segment that will never be delivered, and what built on it; the stream re-snapshots. */
  private drop(p: Pending, tooLarge = false): void {
    this.hooks.count?.('replay_segments_dropped');
    if (tooLarge && !this.warned) {
      this.warned = true;
      console.warn('[SiteQwality RUM] Skipped a replay segment that was too large');
    }
    if (p.fs && tooLarge) return this.hooks.tooLarge?.();
    // A lost snapshot takes what built on it; a lost change leaves a hole until the next one.
    if (p.fs) this.lose(p.stream);
    this.hooks.lost?.(p.stream);
  }

  /** The stream's snapshot is gone: later segments up to its next snapshot go too. */
  private lose(stream: Stream): void {
    let i = 0;
    while (i < this.queue.length) {
      const q = this.queue[i];
      if (q.stream !== stream || q === this.inFlight) i++;
      else if (q.fs) break;
      else {
        this.queue.splice(i, 1);
        this.queued -= q.bytes;
        this.hooks.count?.('replay_segments_dropped');
      }
    }
    if (!this.queue.some((q) => q.stream === stream && q.fs)) this.lostStream = stream;
    stream.css.clear();
  }

  private trim(): void {
    while (this.queue.length > 1 && (this.queue.length > MAX_BUFFERED_SEGMENTS || this.queued > MAX_BUFFERED_BYTES)) {
      const i = this.queue[0] === this.inFlight ? 1 : 0;
      const [p] = this.queue.splice(i, 1);
      this.queued -= p.bytes;
      this.drop(p);
    }
  }

  /**
   * pagehide, in two steps. This one takes what is queued, then `tail`, and counts what cannot
   * go (over the keepalive cap, built on a snapshot left behind, or held by a Retry-After). The
   * returned function sends the rest with keepalive (gzip if ready, else as JSON); it runs after
   * the core's own tail, which comes first.
   */
  unload(tail: { stream: Stream; seg: Segment; rule?: string } | null): () => void {
    if (this.stopped) return () => {};
    const out = this.queue.filter((p) => p !== this.inFlight);
    this.queue = this.inFlight ? [this.inFlight] : [];
    this.queued = this.inFlight ? this.inFlight.bytes : 0;
    if (tail) out.push(this.pending(tail.stream, tail.seg, tail.rule));
    // The last segment of each page load says so, so its compaction need not wait.
    const ends = new Set<Stream>();
    for (let i = out.length - 1; i >= 0; i--) if (!ends.has(out[i].stream)) ends.add(out[i].stream), (out[i].fin = true);
    // A snapshot already in flight usually lands: what follows it still goes.
    const lost = new Set<Stream>(this.lostStream ? [this.lostStream] : []);
    const go: Array<() => void> = [];
    let dropped = 0;
    for (const p of out) {
      if (p.fs) lost.delete(p.stream);
      const body = p.body ?? p.text;
      const size = p.body ? p.body.size : byteLength(p.text);
      if (now() < this.quietUntil || lost.has(p.stream) || size > KEEPALIVE_MAX_BYTES) {
        dropped++;
        if (p.fs) lost.add(p.stream);
        continue;
      }
      // The fetch given refuses anything that cannot go with keepalive by then.
      go.push(() => void this.send(this.fetchFn, `${this.base}/v2/segments`, this.token, body, p.body ? 'application/octet-stream' : 'application/json', size, this.headers(p)));
    }
    if (dropped) this.hooks.count?.('replay_tail_dropped', dropped);
    return () => go.forEach((f) => f());
  }
}
