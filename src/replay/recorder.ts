import type { UrlSanitizer } from '../privacy/url';
import { byteLength } from '../send';
import { SegmentSequence } from './sequence';

// rrweb discriminants, hardcoded so the lazy rrweb chunk stays out of the core
// bundle. Pinned against rrweb's own enums by `replay-url.test.ts`.
const RRWEB_FULL_SNAPSHOT_EVENT_TYPE = 2;
const RRWEB_INCREMENTAL_EVENT_TYPE = 3;
const RRWEB_META_EVENT_TYPE = 4;
const RRWEB_MUTATION_SOURCE = 0;

/** rrweb's default block class, the only blocking this recorder configures. */
const RRWEB_BLOCK_CLASS = 'rr-block';

/** Events in one segment. */
export const SEGMENT_MAX_EVENTS = 500;

/** Request body a segment aims for. A single larger event is sent alone. */
export const SEGMENT_TARGET_BYTES = 750_000;

/** Room for the request fields around the events. */
const ENVELOPE_BYTES = 128;

/** Longest a segment stays open before it is sent. */
export const SEGMENT_MAX_AGE_MS = 30_000;

/** A fresh full snapshot this often, each one starting a new segment. */
export const CHECKOUT_EVERY_MS = 60_000;

export interface ReplaySegment {
  events: unknown[];
  index: number;
}

interface MaybeMetaEvent {
  type?: number;
  data?: { href?: unknown };
}

interface MaybeMutationEvent {
  type?: number;
  data?: {
    source?: number;
    isAttachIframe?: boolean;
    adds?: Array<{ parentId?: number }>;
  };
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

/**
 * rrweb still sends a blocked same-origin iframe's document. Replayed onto the
 * placeholder it wipes the page, and it holds what the page asked to block.
 */
export function isBlockedFrameDocument(
  event: unknown,
  getNode: (id: number) => unknown,
): boolean {
  const e = event as MaybeMutationEvent | null;
  if (
    e?.type !== RRWEB_INCREMENTAL_EVENT_TYPE ||
    e.data?.source !== RRWEB_MUTATION_SOURCE ||
    e.data.isAttachIframe !== true
  ) {
    return false;
  }
  const parentId = e.data.adds?.[0]?.parentId;
  if (typeof parentId !== 'number') return false;
  const frame = getNode(parentId) as Element | null;
  return !!frame?.classList?.contains(RRWEB_BLOCK_CLASS);
}

/**
 * Groups rrweb events into segments: a new one at each checkout, before the
 * byte target or event cap would be passed, and after `SEGMENT_MAX_AGE_MS`.
 */
export class SegmentBuffer {
  private events: unknown[] = [];
  private bytes = ENVELOPE_BYTES;
  private ageTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onSegment: (segment: ReplaySegment) => void,
    private nextIndex: () => number = counter(),
  ) {}

  add(event: unknown, isCheckout = false): void {
    const type = typeOf(event);
    if (isCheckout && type === RRWEB_META_EVENT_TYPE) this.flush();
    // Serialized size plus the comma that joins it in the request body.
    const size = byteLength(JSON.stringify(event)) + 1;
    // A full snapshot stays with the Meta event just before it.
    const withMeta =
      type === RRWEB_FULL_SNAPSHOT_EVENT_TYPE &&
      this.events.length === 1 &&
      typeOf(this.events[0]) === RRWEB_META_EVENT_TYPE;
    if (!withMeta && this.bytes + size > SEGMENT_TARGET_BYTES) this.flush();
    this.events.push(event);
    this.bytes += size;
    if (this.events.length === 1) {
      this.ageTimer = setTimeout(() => this.flush(), SEGMENT_MAX_AGE_MS);
    }
    if (
      this.events.length >= SEGMENT_MAX_EVENTS ||
      this.bytes >= SEGMENT_TARGET_BYTES
    ) {
      this.flush();
    }
  }

  flush(): void {
    if (this.ageTimer) {
      clearTimeout(this.ageTimer);
      this.ageTimer = null;
    }
    if (this.events.length === 0) return;
    const events = this.events;
    this.events = [];
    this.bytes = ENVELOPE_BYTES;
    this.onSegment({ events, index: this.nextIndex() });
  }
}

function typeOf(event: unknown): unknown {
  return (event as { type?: unknown } | null)?.type;
}

function counter(): () => number {
  let next = 0;
  return () => next++;
}

export class ReplayRecorder {
  private stopFn: (() => void) | null = null;
  private buffer: SegmentBuffer | null = null;
  private onPageHide = () => this.buffer?.flush();
  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.buffer?.flush();
  };

  async start(
    sessionId: string,
    onSegment: (segment: ReplaySegment) => void,
    privacySettings: { maskInputs: boolean; maskText: boolean },
    sanitizeUrl: UrlSanitizer,
  ): Promise<void> {
    if (this.stopFn) return; // already recording

    // Lazy-loaded so the core bundle stays small; fetched only when replay starts.
    const { record } = await import('@rrweb/record');
    const sequence = new SegmentSequence(sessionId);
    const buffer = new SegmentBuffer(onSegment, () => sequence.take());
    this.buffer = buffer;
    const getNode = (id: number) => record.mirror.getNode(id);

    this.stopFn =
      record({
        emit: (event, isCheckout) => {
          if (isBlockedFrameDocument(event, getNode)) return;
          buffer.add(sanitizeReplayEvent(event, sanitizeUrl), isCheckout);
        },
        checkoutEveryNms: CHECKOUT_EVERY_MS,
        sampling: { mousemove: 50, scroll: 150, input: 'last' },
        slimDOMOptions: 'all',
        inlineStylesheet: true,
        recordCrossOriginIframes: false,
        recordCanvas: false,
        maskAllInputs: privacySettings.maskInputs,
        maskTextSelector: privacySettings.maskText ? '*' : undefined,
      }) ?? null;

    // Sends the open segment while the page can still send it.
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Stops recording and sends whatever the open segment holds. */
  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.buffer?.flush();
    this.buffer = null;
  }
}
