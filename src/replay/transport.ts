import { send as coreSend, isRefused, Backoff, KEEPALIVE_MAX_BYTES } from '../core/send';
import { byteLength } from '../core/util';

/** Segments held while one is in flight or while backing off. */
export const MAX_BUFFERED_SEGMENTS = 10;

/** Largest request body sent. A bigger segment is dropped, never sent. */
export const MAX_SEGMENT_BYTES = 4_000_000;

/**
 * Bytes held the same way, room for a largest segment and others behind it.
 * Past either cap the oldest segments are dropped.
 */
export const MAX_BUFFERED_BYTES = 2 * MAX_SEGMENT_BYTES;

/** A run of rrweb events, each already serialized, ready to send. */
export interface ReplaySegment {
  index: number;
  /** Each event as JSON. */
  json: string[];
  /** UTF-8 bytes of `json` joined by commas. */
  bytes: number;
  /** Holds a full snapshot, which the page's later segments build on. */
  snapshot: boolean;
  /** The last segment of a page that is going away. */
  final: boolean;
}

interface PendingSegment {
  url: string;
  body: string;
  bytes: number;
  snapshot: boolean;
}

/**
 * Sends replay segments one at a time, in order, with the same failure
 * handling as `TransportManager`: a retryable failure keeps the segment and
 * backs off, any other 4xx drops it, and a 401 or 403 stops replay delivery
 * for the rest of the page.
 *
 * A segment is often past the 64 KiB keepalive cap, where a keepalive request
 * is refused outright; `send` sends those as plain requests instead of
 * silently dropping them.
 *
 * Losing a snapshot segment drops the ones after it until the next snapshot:
 * node ids restart per page load, so they would replay onto another page.
 */
export class ReplayTransport {
  private buffer: PendingSegment[] = [];
  private bufferedBytes = 0;
  private sending: Promise<void> | null = null;
  private inFlight: PendingSegment | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = new Backoff();
  private stopped = false;
  private snapshotLost = false;
  private warnedTooLarge = false;

  /** `send` is the core's on the CDN, so both share one keepalive budget. */
  constructor(
    private endpoint: string,
    private clientToken: string,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
    private send: typeof coreSend = coreSend,
  ) {}

  /** Drops everything queued and sends nothing more (consent withdrawn, opted out, over budget). */
  stop(): void {
    this.stopped = true;
    this.buffer = [];
    this.bufferedBytes = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Queues a segment and starts sending if nothing is in flight. The promise
   * settles when the queue stops moving: everything sent or dropped, or a
   * failure left the rest waiting on a backoff. It never rejects.
   */
  sendSegment(sessionId: string, segment: ReplaySegment): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const head = `{"session_id":${JSON.stringify(sessionId)},"segment_index":${segment.index},"events":[`;
    const bytes = byteLength(head) + segment.bytes + 2;
    const url = `${this.endpoint}?session_id=${sessionId}&segment_index=${segment.index}`;
    if (segment.final) {
      this.sendFinal(url, head, segment, bytes);
      return this.pump();
    }
    if (segment.snapshot) {
      this.snapshotLost = false;
    } else if (this.snapshotLost) {
      return this.pump();
    }
    if (bytes > MAX_SEGMENT_BYTES) {
      this.warnTooLarge();
      if (segment.snapshot) this.snapshotLost = true;
      return this.pump();
    }
    this.buffer.push({
      url,
      body: `${head}${segment.json.join(',')}]}`,
      bytes,
      snapshot: segment.snapshot,
    });
    this.bufferedBytes += bytes;
    this.trim();
    return this.pump();
  }

  /**
   * Unloading cancels a plain request, so the last segment goes alone with
   * keepalive, once its snapshot is in. A larger one is dropped.
   */
  private sendFinal(
    url: string,
    head: string,
    segment: ReplaySegment,
    bytes: number,
  ): void {
    const based =
      segment.snapshot ||
      (!this.snapshotLost &&
        !this.inFlight?.snapshot &&
        !this.buffer.some((s) => s.snapshot));
    if (!based || bytes > KEEPALIVE_MAX_BYTES) return;
    void this.send(this.fetchFn, url, this.clientToken, `${head}${segment.json.join(',')}]}`, 'application/json', bytes);
  }

  private canSend(): boolean {
    return !this.stopped && this.retryTimer === null && this.buffer.length > 0;
  }

  private pump(): Promise<void> {
    if (!this.sending && this.canSend()) this.sending = this.drain();
    return this.sending ?? Promise.resolve();
  }

  /**
   * Entered only when `canSend()`, so the loop body runs at least once and
   * `sending` is cleared after an await, never before `pump` has assigned it.
   */
  private async drain(): Promise<void> {
    do {
      const segment = this.buffer.shift()!;
      this.bufferedBytes -= segment.bytes;
      this.inFlight = segment;
      const outcome = await this.send(this.fetchFn, segment.url, this.clientToken, segment.body, 'application/json', segment.bytes);
      this.inFlight = null;
      if (this.stopped) break;
      if (outcome.kind === 'ok') {
        this.backoff.reset();
      } else if (outcome.kind === 'retryable') {
        this.buffer.unshift(segment);
        this.bufferedBytes += segment.bytes;
        this.trim();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.pump();
        }, this.backoff.next(outcome.retryAfterMs));
      } else if (isRefused(outcome) || outcome.status === 0) {
        // Refused by the intake, or by the request budget: nothing more goes.
        this.stop();
      } else {
        // Any other permanent failure drops just this segment.
        if (outcome.status === 413) this.warnTooLarge();
        if (segment.snapshot) this.loseSnapshot();
      }
    } while (this.canSend());
    this.sending = null;
  }

  /** Drops the queued segments that built on a snapshot just dropped. */
  private loseSnapshot(): void {
    while (this.buffer.length > 0 && !this.buffer[0].snapshot) {
      this.bufferedBytes -= this.buffer.shift()!.bytes;
    }
    this.snapshotLost = this.buffer.length === 0;
  }

  private warnTooLarge(): void {
    if (this.warnedTooLarge) return;
    this.warnedTooLarge = true;
    console.warn('[SiteQwality RUM] Skipped a replay segment that was too large');
  }

  private trim(): void {
    while (
      this.buffer.length > MAX_BUFFERED_SEGMENTS ||
      (this.bufferedBytes > MAX_BUFFERED_BYTES && this.buffer.length > 1)
    ) {
      const dropped = this.buffer.shift()!;
      this.bufferedBytes -= dropped.bytes;
      if (dropped.snapshot) this.loseSnapshot();
    }
  }
}
