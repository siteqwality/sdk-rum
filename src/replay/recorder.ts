import type { UrlSanitizer } from '../core/url';
import type { record as rrwebRecord } from '@rrweb/record';
import { byteLength } from '../core/util';
import { SegmentSequence } from './sequence';
import { MAX_SEGMENT_BYTES, type ReplaySegment } from './transport';

export type { ReplaySegment } from './transport';

// rrweb discriminants, hardcoded so the lazy rrweb chunk stays out of the core
// bundle. Pinned against rrweb's own enums by `replay-url.test.ts`.
const RRWEB_FULL_SNAPSHOT_EVENT_TYPE = 2;
const RRWEB_INCREMENTAL_EVENT_TYPE = 3;
const RRWEB_META_EVENT_TYPE = 4;
const RRWEB_MUTATION_SOURCE = 0;
const RRWEB_DOCUMENT_NODE_TYPE = 0;

/** Elements whose content and attributes replay never records. */
export const HIDDEN_INPUT_SELECTOR = 'input[type="hidden" i]';

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

export type RecordFn = typeof rrwebRecord;
type RecordOptions = NonNullable<Parameters<RecordFn>[0]>;
type GetNode = (id: number) => unknown;

interface MaybeMetaEvent {
  type?: number;
  data?: { href?: unknown };
}

interface MaybeIncrementalEvent {
  type?: number;
  timestamp?: number;
  data?: {
    source?: number;
    id?: number;
    positions?: Array<{ id?: number }>;
    adds?: Array<{ parentId?: number; node?: { type?: number } }>;
    removes?: Array<{ parentId?: number }>;
    texts?: Array<{ id?: number }>;
    attributes?: Array<{ id?: number }>;
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
 * The event without anything inside an iframe, or null if nothing is left.
 * The player cannot draw frame documents; adding one wipes the page.
 */
export function withoutFrameContent(
  event: unknown,
  getNode: GetNode,
): unknown {
  const e = event as MaybeIncrementalEvent | null;
  const data = e?.data;
  if (e?.type !== RRWEB_INCREMENTAL_EVENT_TYPE || !data) return event;
  // A node rrweb no longer knows is kept: only a remove can name one.
  const inPage = (id: unknown) => {
    if (typeof id !== 'number') return true;
    const node = getNode(id) as Node | null;
    return !node || node === document || node.ownerDocument === document;
  };

  if (data.source === RRWEB_MUTATION_SOURCE) {
    const adds = (data.adds ?? []).filter(
      (a) => a.node?.type !== RRWEB_DOCUMENT_NODE_TYPE && inPage(a.parentId),
    );
    const removes = (data.removes ?? []).filter((r) => inPage(r.parentId));
    const texts = (data.texts ?? []).filter((t) => inPage(t.id));
    const attributes = (data.attributes ?? []).filter((a) => inPage(a.id));
    const kept = adds.length + removes.length + texts.length + attributes.length;
    const total =
      (data.adds?.length ?? 0) +
      (data.removes?.length ?? 0) +
      (data.texts?.length ?? 0) +
      (data.attributes?.length ?? 0);
    if (kept === total) return event;
    if (kept === 0) return null;
    return { ...e, data: { ...data, adds, removes, texts, attributes } };
  }
  if (Array.isArray(data.positions)) {
    const positions = data.positions.filter((p) => inPage(p.id));
    if (positions.length === data.positions.length) return event;
    return positions.length ? { ...e, data: { ...data, positions } } : null;
  }
  return inPage(data.id) ? event : null;
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

  /** Drops the open segment unsent. */
  discard(): void {
    if (this.ageTimer) {
      clearTimeout(this.ageTimer);
      this.ageTimer = null;
    }
    this.json = [];
    this.bytes = 0;
    this.snapshot = false;
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

/** Privacy options from the app's level and selectors (design 7.1). */
export interface ReplayPrivacy {
  maskInputs: boolean;
  /** Every text node masked except `unmaskSelector` (Strict, or legacy mask_text). */
  maskAllText: boolean;
  maskSelector?: string;
  unmaskSelector?: string;
  /** The app's block selectors; Strict adds media. Hidden inputs are always blocked. */
  blockSelector: string;
  ignoreSelector?: string;
  /** PII patterns, masked with `*` to keep the layout. */
  scrub?: (text: string) => string;
}

export type ReplayState = 'recording' | 'paused' | 'stopped';

const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'data', 'background', 'cite', 'ping', 'xlink:href'];

const closest = (el: Element | null, selector?: string) => {
  try {
    return !!selector && !!el?.closest?.(selector);
  } catch {
    return false;
  }
};

export function recordOptions(p: ReplayPrivacy): RecordOptions {
  const stars = (t: string) => t.replace(/\S/g, '*');
  const masking = p.maskAllText || !!p.maskSelector || !!p.scrub;
  return {
    sampling: { mousemove: 50, scroll: 150 },
    slimDOMOptions: 'all',
    inlineStylesheet: true,
    recordCrossOriginIframes: false,
    recordCanvas: false,
    maskAllInputs: p.maskInputs,
    // Password, email, phone and card fields can never be unmasked (7.1).
    maskInputOptions: { password: true, email: true, tel: true },
    // Hidden inputs (CSRF tokens) are never recorded, whatever the level.
    blockSelector: [HIDDEN_INPUT_SELECTOR, p.blockSelector, p.maskInputs ? '' : 'input[autocomplete^="cc-" i]'].filter(Boolean).join(','),
    ignoreSelector: p.ignoreSelector,
    maskTextSelector: masking ? '*' : undefined,
    maskTextFn: masking
      ? (text: string, el: HTMLElement | null) =>
          (p.maskAllText ? !closest(el, p.unmaskSelector) : closest(el, p.maskSelector))
            ? stars(text)
            : p.scrub
              ? p.scrub(text)
              : text
      : undefined,
  };
}

interface SerializedNode {
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

/** URL attributes minimised and the rest PII-scrubbed, in snapshots and mutations, in place. */
export function cleanAttributes(
  attrs: Record<string, unknown> | undefined,
  url: UrlSanitizer,
  text: (s: string) => string,
  scrub?: (s: string) => string,
): void {
  if (!attrs) return;
  for (const name of Object.keys(attrs)) {
    const v = attrs[name];
    if (name === '_cssText' || name.startsWith('rr_')) continue;
    if (typeof v === 'string') {
      let out = URL_ATTRS.includes(name.toLowerCase())
        ? url(v)
        : name === 'srcset'
          ? v.split(',').map((part) => part.trim().replace(/^\S+/, (u) => url(u))).join(', ')
          : text(v);
      if (scrub) out = scrub(out);
      attrs[name] = out;
    } else if (v && typeof v === 'object') {
      // A style diff: property to value or [value, priority].
      for (const [k, sv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof sv === 'string') (v as Record<string, unknown>)[k] = text(sv);
      }
    }
  }
}

function cleanNode(n: SerializedNode | undefined, clean: (a?: Record<string, unknown>) => void): void {
  if (!n) return;
  clean(n.attributes);
  if (Array.isArray(n.childNodes)) for (const c of n.childNodes) cleanNode(c, clean);
}

/** Minimises URLs in DOM attributes of full snapshots and mutations (mutates the event). */
export function cleanDomEvent(event: unknown, clean: (a?: Record<string, unknown>) => void): void {
  const e = event as { type?: number; data?: { node?: SerializedNode; source?: number; adds?: Array<{ node?: SerializedNode }>; attributes?: Array<{ attributes?: Record<string, unknown> }> } } | null;
  const d = e?.data;
  if (!d) return;
  if (e.type === RRWEB_FULL_SNAPSHOT_EVENT_TYPE) cleanNode(d.node, clean);
  else if (e.type === RRWEB_INCREMENTAL_EVENT_TYPE && d.source === RRWEB_MUTATION_SOURCE) {
    for (const a of d.adds ?? []) cleanNode(a.node, clean);
    for (const a of d.attributes ?? []) clean(a.attributes);
  }
}

export interface RecorderOptions {
  sessionId: string;
  record: RecordFn;
  onSegment: (segment: ReplaySegment) => void;
  privacy: ReplayPrivacy;
  url: UrlSanitizer;
  text: (s: string) => string;
  onStatus?: (state: ReplayState, reason?: string) => void;
}

export class ReplayRecorder {
  private record: RecordFn | null = null;
  private options: RecordOptions = {};
  private stopRecord: (() => void) | null = null;
  private buffer: SegmentBuffer | null = null;
  private sanitizeUrl: UrlSanitizer = String;
  private clean: (a?: Record<string, unknown>) => void = () => {};
  private onStatus: RecorderOptions['onStatus'];
  /** Bumped on every restart, so a stopped recording's late events are ignored. */
  private generation = 0;
  private snapshotAt = 0;
  private checkoutQueued = false;
  private paused = false;
  private onPageHide = () => this.buffer?.flush(true);
  private onPageShow = (event: PageTransitionEvent) => {
    // Back from the back-forward cache: other pages may have run since.
    if (event.persisted && !this.paused) this.capture();
  };
  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.buffer?.flush();
  };

  start(o: RecorderOptions): void {
    if (this.buffer) return;
    const sequence = new SegmentSequence(o.sessionId);
    this.buffer = new SegmentBuffer(o.onSegment, () => sequence.take());
    this.record = o.record;
    this.sanitizeUrl = o.url;
    this.onStatus = o.onStatus;
    this.clean = (a) => cleanAttributes(a, o.url, o.text, o.privacy.scrub);
    this.options = recordOptions(o.privacy);
    this.capture();
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Stops recording and sends whatever the open segment holds. */
  stop(): void {
    this.generation++;
    this.stopRecord?.();
    this.stopRecord = null;
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.buffer?.flush();
    this.buffer = null;
  }

  /** Pauses on a never-record page; a custom `sq-pause` event marks the gap. */
  pause(reason: string): void {
    if (this.paused || !this.buffer || !this.record) return;
    this.paused = true;
    try {
      this.record.addCustomEvent('sq-pause', { reason });
    } catch {
      // Not recording yet.
    }
    this.generation++;
    this.stopRecord?.();
    this.stopRecord = null;
    this.buffer.flush();
    this.onStatus?.('paused', reason);
  }

  /** Resumes with a full snapshot. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.capture();
  }

  /**
   * Restarts rrweb for a fresh snapshot. Unlike rrweb's own checkout, this
   * leaves one set of observers per iframe instead of one more each time.
   */
  private capture(): void {
    if (!this.buffer || !this.record || this.paused) return;
    this.stopRecord?.();
    this.stopRecord = null;
    this.buffer.flush();
    const generation = ++this.generation;
    const { mirror } = this.record;
    this.stopRecord =
      this.record({
        ...this.options,
        emit: (event) => this.onEvent(event, generation, (id) => mirror.getNode(id)),
      }) ?? null;
    this.onStatus?.('recording');
  }

  private onEvent(event: unknown, generation: number, getNode: GetNode): void {
    if (generation !== this.generation || !this.buffer) return;
    const kept = withoutFrameContent(event, getNode);
    if (kept === null) return;
    cleanDomEvent(kept, this.clean);
    if (!this.buffer.add(sanitizeReplayEvent(kept, this.sanitizeUrl))) {
      // Its later events would replay onto another page, so the page stops here.
      // The Meta event alone cannot play, so nothing of the page is sent.
      this.buffer.discard();
      this.generation++;
      console.warn('[SiteQwality RUM] Stopped session replay: this page is too large to record');
      this.onStatus?.('stopped', 'too_large');
      queueMicrotask(() => this.stop());
      return;
    }
    const e = kept as MaybeIncrementalEvent;
    const at = e.timestamp ?? 0;
    if (e.type === RRWEB_FULL_SNAPSHOT_EVENT_TYPE) {
      this.snapshotAt = at;
    } else if (
      e.type === RRWEB_INCREMENTAL_EVENT_TYPE &&
      at - this.snapshotAt > CHECKOUT_EVERY_MS &&
      !this.checkoutQueued
    ) {
      // Outside rrweb's own callback, like its checkout but after it returns.
      this.checkoutQueued = true;
      queueMicrotask(() => {
        this.checkoutQueued = false;
        this.capture();
      });
    }
  }
}
