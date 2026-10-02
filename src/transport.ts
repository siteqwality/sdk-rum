import { sendJson } from './send';

export class TransportManager {
  private queue: unknown[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private endpoint: string,
    private clientToken: string,
    private flushIntervalMs: number,
  ) {
    this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);

    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush();
      });
      window.addEventListener('pagehide', () => this.flush());
    }
  }

  enqueue(event: unknown): void {
    this.queue.push(event);
    if (this.queue.length >= 50) {
      this.flush();
      return;
    }
    // Anything enqueued while the page is already hidden has to go out now.
    // This listener is registered in the constructor, before the collectors
    // exist, so on the way out our flush runs first and web-vitals finalizes
    // CLS and INP after it: that last measure would otherwise sit in the queue
    // waiting for an interval tick that never comes.
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    ) {
      this.flush();
    }
  }

  /**
   * Sends the queue. Every batch goes out the same way, including the last one
   * on tab hide or unload: `sendJson` uses a keepalive fetch, which outlives
   * the page. See there for why this is not `navigator.sendBeacon`.
   */
  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    sendJson(this.endpoint, this.clientToken, JSON.stringify(batch));
  }

  destroy(): void {
    this.flush();
    if (this.flushTimer) clearInterval(this.flushTimer);
  }
}
