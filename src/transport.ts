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
    if (this.queue.length >= 50) this.flush();
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
        // silent fail — fire and forget
      });
    }
  }

  destroy(): void {
    this.flush(true);
    if (this.flushTimer) clearInterval(this.flushTimer);
  }
}
