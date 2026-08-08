import type { UrlSanitizer } from '../privacy/url';

// rrweb is lazy-loaded to keep the core SDK bundle small (~30KB gzipped).
// The full rrweb library is only fetched when replay recording is activated.
type RrwebRecord = typeof import('rrweb').record;

/**
 * rrweb's `EventType.Meta` discriminant. Hardcoded rather than imported so the
 * lazily-loaded rrweb chunk is not pulled into the core bundle just to read one
 * enum. Pinned by `replay-url.test.ts`, which asserts against rrweb's own
 * exported enum.
 */
const RRWEB_META_EVENT_TYPE = 4;

interface MaybeMetaEvent {
  type?: number;
  data?: { href?: unknown };
}

/**
 * Sanitise the page URL rrweb embeds in its Meta event.
 *
 * rrweb emits a Meta event on start and on every SPA navigation, carrying the
 * full `location.href` including its query string and fragment. Left alone it
 * reintroduces, inside the replay segment, exactly the data the view collector
 * strips. Rewriting the event after `emit` reaches it needs no rrweb fork.
 *
 * **What this does not reach:** URLs inside the DOM snapshot itself, i.e. the
 * `src` and `href` attributes of the recorded page, are produced by rrweb's
 * serialiser and would need a fork or an upstream option to filter. They are
 * left as recorded.
 */
export function sanitizeReplayEvent(
  event: unknown,
  sanitizeUrl: UrlSanitizer,
): unknown {
  const candidate = event as MaybeMetaEvent | null;
  if (
    !candidate ||
    candidate.type !== RRWEB_META_EVENT_TYPE ||
    !candidate.data ||
    typeof candidate.data.href !== 'string'
  ) {
    return event;
  }
  return {
    ...candidate,
    data: { ...candidate.data, href: sanitizeUrl(candidate.data.href) },
  };
}

export class ReplayRecorder {
  private stopFn: (() => void) | null = null;
  private segmentIndex = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  async start(
    onSegment: (segment: { events: unknown[]; index: number }) => void,
    privacySettings: { maskInputs: boolean; maskText: boolean },
    sanitizeUrl: UrlSanitizer,
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
        events.push(sanitizeReplayEvent(event, sanitizeUrl));
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
