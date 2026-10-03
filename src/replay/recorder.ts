import type { UrlSanitizer } from '../privacy/url';
import { byteLength } from '../send';
import { SegmentSequence } from './sequence';
import { MAX_SEGMENT_BYTES, type ReplaySegment } from './transport';

export type { ReplaySegment } from './transport';

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
 * Groups serialized rrweb events into segments: a Meta event opens one, a full
 * snapshot, the byte target, the event cap or `SEGMENT_MAX_AGE_MS` closes it.
 */
export class SegmentBuffer {
  private json: string[] = [];
  /** Event bytes plus the comma that joins each one. */
  private bytes = 0;
  private opensWithMeta = false;
  private snapshot = false;
  private ageTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onSegment: (segment: ReplaySegment) => void,
    private nextIndex: () => number = counter(),
  ) {}

  /** Adds an event. False, and nothing added, for a snapshot too large to send. */
  add(event: unknown): boolean {
    const type = typeOf(event);
    if (type === RRWEB_META_EVENT_TYPE) this.flush();
    const json = JSON.stringify(event);
    const size = byteLength(json) + 1;
    const isSnapshot = type === RRWEB_FULL_SNAPSHOT_EVENT_TYPE;
    // A full snapshot stays with the Meta event just before it.
    const withMeta = isSnapshot && this.opensWithMeta && this.json.length === 1;
    if (isSnapshot && ENVELOPE_BYTES + (withMeta ? this.bytes : 0) + size > MAX_SEGMENT_BYTES) {
      return false;
    }
    if (!withMeta && ENVELOPE_BYTES + this.bytes + size > SEGMENT_TARGET_BYTES) {
      this.flush();
    }
    if (this.json.length === 0) {
      this.opensWithMeta = type === RRWEB_META_EVENT_TYPE;
      this.ageTimer = setTimeout(() => this.flush(), SEGMENT_MAX_AGE_MS);
    }
    this.json.push(json);
    this.bytes += size;
    if (isSnapshot) this.snapshot = true;
    // The snapshot goes at once, so even a short page view has it delivered.
    if (
      isSnapshot ||
      this.json.length >= SEGMENT_MAX_EVENTS ||
      ENVELOPE_BYTES + this.bytes >= SEGMENT_TARGET_BYTES
    ) {
      this.flush();
    }
    return true;
  }

  /** Sends the open segment; `final` when the page is going away. */
  flush(final = false): void {
    if (this.ageTimer) {
      clearTimeout(this.ageTimer);
      this.ageTimer = null;
    }
    if (this.json.length === 0) return;
    const segment: ReplaySegment = {
      index: this.nextIndex(),
      json: this.json,
      bytes: this.bytes - 1,
      snapshot: this.snapshot,
      final,
    };
    this.json = [];
    this.bytes = 0;
    this.snapshot = false;
    this.onSegment(segment);
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
  private onPageHide = () => this.buffer?.flush(true);
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
    let halted = false;

    this.stopFn =
      record({
        emit: (event) => {
          if (halted || isBlockedFrameDocument(event, getNode)) return;
          if (!buffer.add(sanitizeReplayEvent(event, sanitizeUrl))) {
            // Its later events would replay onto another page, so the page stops here.
            halted = true;
            console.warn('[SiteQwality RUM] Stopped session replay: this page is too large to record');
            queueMicrotask(() => this.stop());
          }
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
