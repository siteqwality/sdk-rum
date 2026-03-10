// rrweb is lazy-loaded to keep the core SDK bundle small (~30KB gzipped).
// The full rrweb library is only fetched when replay recording is activated.
type RrwebRecord = typeof import('rrweb').record;

export class ReplayRecorder {
  private stopFn: (() => void) | null = null;
  private segmentIndex = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  async start(
    onSegment: (segment: { events: unknown[]; index: number }) => void,
    privacySettings: { maskInputs: boolean; maskText: boolean },
  ): Promise<void> {
    if (this.stopFn) return; // already recording

    // Dynamically import rrweb only when replay is needed
    const { record } = await import('rrweb');

    const events: unknown[] = [];

    const flushSegment = () => {
      if (events.length === 0) return;
      const batch = events.splice(0);
      onSegment({ events: batch, index: this.segmentIndex++ });
    };

    this.stopFn = (record as RrwebRecord)({
      emit: (event) => {
        events.push(event);
        // Flush at 100 events
        if (events.length >= 100) flushSegment();
      },
      maskAllInputs: privacySettings.maskInputs,
      maskTextSelector: privacySettings.maskText ? '*' : undefined,
    }) ?? null;

    // Flush segment every 30 seconds
    this.flushTimer = setInterval(flushSegment, 30_000);
  }

  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
