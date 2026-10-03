import { sendJson, isRefused, Backoff, type SendOutcome } from './send';

/** A request carries at most this many events, and reaching it triggers a send. */
const MAX_BATCH_EVENTS = 50;

/**
 * Past this the oldest queued events are dropped, so an outage or a long
 * backoff cannot grow the host page's memory without bound.
 */
export const MAX_QUEUED_EVENTS = 1_000;

/**
 * Minimum time between two sends while the page is hidden, other than the
 * flush on hide itself and the one late send after it.
 *
 * A hidden page used to send on every enqueue. The SDK's own POSTs showed up as
 * resource entries, each one was enqueued, and each enqueue sent again: one
 * hidden tab looped at network speed for as long as it stayed open. The
 * resource collector now ignores our own endpoints, and this spacing bounds any
 * other loop of that shape to one request per interval.
 */
export const HIDDEN_SEND_SPACING_MS = 5_000;

/**
 * Queues events and POSTs them in batches to one ingest endpoint.
 *
 * At most one request is in flight. A retryable failure (see `SendOutcome`)
 * puts the batch back at the front of the queue and backs off; while backing
 * off nothing is sent on the interval or on size. A permanent failure drops
 * the batch, and a 401 or 403 stops this transport for the rest of the page.
 *
 * The flush on hide and on unload is the exception to all of that: the page
 * may be about to go away, so it sends at once whatever is in flight, and
 * makes one attempt even while backing off.
 */
export class TransportManager {
  private queue: unknown[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenSendTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = new Backoff();
  private inFlight = 0;
  private stopped = false;
  private hiddenSendScheduled = false;
  private lateSendAllowed = false;
  private lastSendAt = -Infinity;

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.onHide();
  };
  private readonly onPageHide = (): void => this.onHide();

  constructor(
    private endpoint: string,
    private clientToken: string,
    private flushIntervalMs: number,
  ) {
    this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);

    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', this.onVisibilityChange);
      window.addEventListener('pagehide', this.onPageHide);
    }
  }

  enqueue(event: unknown): void {
    if (this.stopped) return;
    this.queue.push(event);
    this.trimQueue();
    // Anything enqueued while the page is already hidden has to go out soon:
    // a hidden page may be frozen or discarded before the next interval tick.
    // That includes a CLS or INP measure web-vitals finalizes on the way out
    // when its listener runs after our flush on hide. It goes out in one
    // coalesced send rather than one send per event; see scheduleHiddenSend.
    if (isHidden()) {
      this.scheduleHiddenSend();
      return;
    }
    if (this.queue.length >= MAX_BATCH_EVENTS) this.flush();
  }

  /**
   * Sends the next batch, unless a request is already in flight (its outcome
   * picks up from here) or the transport is backing off (the retry does). On a
   * hidden page a send too soon after the previous one is deferred.
   *
   * Every batch goes out the same way, including the last one on tab hide or
   * unload: `sendJson` uses a keepalive fetch, which outlives the page. See
   * there for why this is not `navigator.sendBeacon`.
   */
  flush(): void {
    if (this.stopped || this.queue.length === 0) return;
    if (this.inFlight > 0 || this.retryTimer !== null) return;
    if (isHidden() && Date.now() < this.lastSendAt + HIDDEN_SEND_SPACING_MS) {
      this.scheduleHiddenSend();
      return;
    }
    this.send();
  }

  destroy(): void {
    this.flushFinal();
    this.stopped = true;
    this.clearTimers();
    if (typeof window !== 'undefined') {
      window.removeEventListener('visibilitychange', this.onVisibilityChange);
      window.removeEventListener('pagehide', this.onPageHide);
    }
  }

  private onHide(): void {
    this.flushFinal();
    // One send right after this one may skip the queue too: whatever is
    // enqueued while this event is still being handled, such as the late
    // CLS/INP measure. Only one, so a loop cannot ride on it.
    this.lateSendAllowed = true;
    setTimeout(() => {
      this.lateSendAllowed = false;
    }, 0);
  }

  /**
   * The flush on hide and on unload: sends now, regardless of a request in
   * flight. While backing off it makes one attempt with one batch; otherwise
   * it sends everything queued.
   */
  private flushFinal(): void {
    if (this.stopped) return;
    const backingOff = this.retryTimer !== null;
    while (this.queue.length > 0) {
      this.send();
      if (backingOff) break;
    }
  }

  /**
   * Coalesces sends from a hidden page into one scheduled send. The first goes
   * out in a microtask, which still runs inside the event that enqueued it;
   * later ones are spaced `HIDDEN_SEND_SPACING_MS` apart.
   */
  private scheduleHiddenSend(): void {
    if (this.stopped) return;
    // Checked before the pending flag: a spaced send scheduled before the hide
    // must not hold the late measure back, its timer may never fire.
    if (this.lateSendAllowed) {
      this.lateSendAllowed = false;
      // A microtask, so everything enqueued alongside it goes in this send.
      void Promise.resolve().then(() => this.flushFinal());
      return;
    }
    if (this.hiddenSendScheduled) return;
    // The outcome of the request in flight, or the retry, picks up from here.
    if (this.inFlight > 0 || this.retryTimer !== null) return;

    this.hiddenSendScheduled = true;
    const run = (): void => {
      this.hiddenSendScheduled = false;
      this.hiddenSendTimer = null;
      this.flush();
    };
    const wait = this.lastSendAt + HIDDEN_SEND_SPACING_MS - Date.now();
    if (wait > 0) {
      this.hiddenSendTimer = setTimeout(run, wait);
    } else {
      void Promise.resolve().then(run);
    }
  }

  private send(): void {
    const batch = this.queue.splice(0, MAX_BATCH_EVENTS);
    this.inFlight++;
    this.lastSendAt = Date.now();
    void sendJson(this.endpoint, this.clientToken, JSON.stringify(batch)).then(
      (outcome) => {
        this.inFlight--;
        this.settle(batch, outcome);
      },
    );
  }

  private settle(batch: unknown[], outcome: SendOutcome): void {
    if (this.stopped) return;
    if (outcome.kind === 'retryable') {
      this.queue.unshift(...batch);
      this.trimQueue();
      this.scheduleRetry(outcome.retryAfterMs);
      return;
    }
    if (isRefused(outcome)) {
      this.stop();
      return;
    }
    if (outcome.kind === 'ok') {
      this.backoff.reset();
      // A final attempt got through while backing off: resume normal sending.
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    }
    // A permanent failure other than 401/403 drops just this batch.
    this.resume();
  }

  /** After a request settles, sends what has built up meanwhile. */
  private resume(): void {
    if (this.queue.length === 0 || this.retryTimer !== null) return;
    if (isHidden()) {
      this.scheduleHiddenSend();
    } else if (this.queue.length >= MAX_BATCH_EVENTS) {
      this.flush();
    }
  }

  private scheduleRetry(retryAfterMs?: number): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush();
    }, this.backoff.next(retryAfterMs));
  }

  /** 401 or 403: nothing more goes out from this transport on this page. */
  private stop(): void {
    this.stopped = true;
    this.queue = [];
    this.clearTimers();
  }

  private trimQueue(): void {
    const excess = this.queue.length - MAX_QUEUED_EVENTS;
    if (excess > 0) this.queue.splice(0, excess);
  }

  private clearTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.hiddenSendTimer) clearTimeout(this.hiddenSendTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.hiddenSendTimer = null;
  }
}

function isHidden(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  );
}
