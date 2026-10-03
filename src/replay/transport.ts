import { sendJson, isRefused, Backoff, byteLength } from '../send';

/** Segments held while one is in flight or while backing off. */
export const MAX_BUFFERED_SEGMENTS = 10;

/**
 * Bytes held the same way. Past either cap the oldest segments are dropped,
 * though the newest is always kept even if it alone is over this.
 */
export const MAX_BUFFERED_BYTES = 4_000_000;

interface PendingSegment {
  url: string;
  body: string;
  bytes: number;
}

/**
 * Sends replay segments one at a time, in order, with the same failure
 * handling as `TransportManager`: a retryable failure keeps the segment and
 * backs off, any other 4xx drops it, and a 401 or 403 stops replay delivery
 * for the rest of the page.
 *
 * A segment is often past the 64 KiB keepalive cap, where a keepalive request
 * is refused outright; `sendJson` sends those as plain requests instead of
 * silently dropping them.
 */
export class ReplayTransport {
  private buffer: PendingSegment[] = [];
  private bufferedBytes = 0;
  private sending: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = new Backoff();
  private stopped = false;

  constructor(
    private endpoint: string,
    private clientToken: string,
  ) {}

  /**
   * Queues a segment and starts sending if nothing is in flight. The promise
   * settles when the queue stops moving: everything sent or dropped, or a
   * failure left the rest waiting on a backoff. It never rejects.
   */
  sendSegment(
    sessionId: string,
    segment: { events: unknown[]; index: number },
  ): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const body = JSON.stringify({
      session_id: sessionId,
      segment_index: segment.index,
      events: segment.events,
    });
    this.buffer.push({
      url: `${this.endpoint}?session_id=${sessionId}&segment_index=${segment.index}`,
      body,
      bytes: byteLength(body),
    });
    this.bufferedBytes += this.buffer[this.buffer.length - 1].bytes;
    this.trim();
    return this.pump();
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
      const outcome = await sendJson(segment.url, this.clientToken, segment.body);
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
      } else if (isRefused(outcome)) {
        this.stopped = true;
        this.buffer = [];
        this.bufferedBytes = 0;
      }
      // Any other permanent failure drops just this segment.
    } while (this.canSend());
    this.sending = null;
  }

  private trim(): void {
    while (
      this.buffer.length > MAX_BUFFERED_SEGMENTS ||
      (this.bufferedBytes > MAX_BUFFERED_BYTES && this.buffer.length > 1)
    ) {
      this.bufferedBytes -= this.buffer.shift()!.bytes;
    }
  }
}
