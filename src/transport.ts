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
        if (document.visibilityState === 'hidden') this.flush(true);
      });
      window.addEventListener('pagehide', () => this.flush(true));
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
      this.flush(true);
    }
  }

  flush(useBeacon = false): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    const body = JSON.stringify(batch);

    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(
        this.endpoint + '?token=' + this.clientToken,
        blob,
      );
    } else {
      fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.clientToken}`,
        },
        body,
        keepalive: true,
      }).catch(() => {
        // silent fail: fire and forget
      });
    }
  }

  destroy(): void {
    this.flush(true);
    if (this.flushTimer) clearInterval(this.flushTimer);
  }
}
