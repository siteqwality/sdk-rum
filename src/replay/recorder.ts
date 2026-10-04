// The recorder (design 5.4, 5.5): rrweb restarted for each snapshot, every event cleaned,
// throttled and serialized once, then segmented. Buffer mode holds the last two checkouts in
// the ring until go(); stream mode hands segments out as they close.
import type { UrlSanitizer } from '../core/url';
import { byteLength } from '../core/util';
import { KEEPALIVE_MAX_BYTES } from '../core/send';
import { Segmenter, Ring, FULL_SNAPSHOT, INCREMENTAL, CUSTOM, SEGMENT_MAX_AGE_MS, SEGMENT_MAX_BYTES, RING_STALE_MS, RING_MAX_BYTES, type Segment } from './segmenter';
import { MutationThrottle } from './throttle';
import { CSS_REF_MIN } from './css';
import type { Stream } from './stream';
import { cleanAttributes, cleanDomEvent, recordOptions, sanitizeReplayEvent, withoutFrameContent, type GetNode, type RecordFn, type ReplayPrivacy, type ReplayState } from './privacy';

export * from './privacy';

const MUTATION = 0;

/** A full snapshot over this, after CSS references, stops replay for the page load (5.5). */
export const SNAPSHOT_MAX_BYTES = 4_000_000;
/** Streaming: a fresh snapshot this often, taken where a segment closes (5.4). */
export const CHECKOUT_EVERY_MS = 180_000;
/** Buffering: a checkout this often, or after this much since the last, so the ring stays 60 to 120 s. */
export const BUFFER_CHECKOUT_MS = 60_000;
export const BUFFER_CHECKOUT_BYTES = SEGMENT_MAX_BYTES;
/** A resync after throttling or a lost snapshot comes at most this often. */
export const RESYNC_MIN_MS = 30_000;

export type Why = 'start' | 'resume' | 'checkout' | 'resync';

export interface RecorderOptions {
  record: RecordFn;
  privacy: ReplayPrivacy;
  url: UrlSanitizer;
  text: (s: string) => string;
  /** The SDK's clock: rrweb stamps events with Date, which pages patch. */
  now: () => number;
  /** The stream new snapshots belong to; a back-forward cache restore starts another. */
  stream: () => Stream;
  /** Buffer into the ring until go(). */
  buffer?: boolean;
  /** Closed segments, in stream mode (the ring's at go()). */
  onSegment: (segment: Segment, stream: Stream) => void;
  onStatus?: (state: ReplayState, reason?: string) => void;
  count?: (name: string, n?: number) => void;
  /** Starts paused for this reason: nothing is captured until resume(). */
  paused?: string;
}

interface Tagged extends Segment {
  stream: Stream;
}

export class ReplayRecorder {
  private o!: RecorderOptions;
  private options: ReturnType<typeof recordOptions> = {};
  private stopRecord: (() => void) | null = null;
  private segmenter!: Segmenter;
  private ring = new Ring();
  private throttle!: MutationThrottle;
  private stream!: Stream;
  private clean: (a?: Record<string, unknown>) => void = () => {};
  /** Bumped on every restart, so a stopped recording's late events are ignored. */
  private generation = 0;
  private buffering = false;
  private ringLost = false;
  private paused = false;
  private started = false;
  private snapshotAt = 0;
  private sinceSnapshot = 0;
  /** Why the current snapshot was taken. */
  private why: Why = 'start';
  private queued = false;
  private resyncAt = -Infinity;
  /** A resync asked for within RESYNC_MIN_MS of the last: taken once that has passed. */
  private resyncDue = false;
  private tick: ReturnType<typeof setInterval> | undefined;

  start(o: RecorderOptions): void {
    if (this.started) return;
    this.started = true;
    this.o = o;
    this.buffering = !!o.buffer;
    this.options = recordOptions(o.privacy);
    this.clean = (a) => cleanAttributes(a, o.url, o.text, o.privacy.scrub);
    const { mirror } = o.record;
    // An svg's children share its bucket, so one animated chart cannot flood.
    this.throttle = new MutationThrottle((id) => {
      const n = mirror.getNode(id);
      const svg = n instanceof Element && n.nodeName !== 'svg' ? n.closest('svg') : null;
      return svg ? mirror.getId(svg) : id;
    });
    this.segmenter = new Segmenter((s) => this.closed(s as Tagged), this.buffering ? Infinity : SEGMENT_MAX_AGE_MS, () => this.due());
    if (o.paused) {
      this.paused = true;
      this.status('paused', o.paused);
    } else this.capture('start');
  }

  get recording(): boolean {
    return !!this.stopRecord;
  }

  /** A replay rule matched: the ring goes out, oldest first, and segments stream from here. */
  go(): void {
    if (!this.started || !this.buffering) return;
    this.segmenter.close();
    this.buffering = false;
    this.segmenter.maxAge = SEGMENT_MAX_AGE_MS;
    // A paused tab's old checkouts are stale; a recording one's last is the base of what follows.
    for (const s of this.ring.take(this.o.now() - RING_STALE_MS, !this.paused) as Tagged[]) this.o.onSegment(s, s.stream);
    if (this.ringLost) this.capture('start');
    if (this.started && !this.paused) this.status('recording');
  }

  /** Stops recording: the open segment is sent (stream mode) or everything is dropped. */
  stop(discard = false): void {
    if (!this.started) return;
    this.end();
    this.halt();
    if (discard || this.buffering) {
      this.segmenter.discard();
      this.ring.clear();
    } else this.segmenter.close();
    this.started = false;
  }

  /** Pauses (hidden, idle, never-record page); a custom `sq-pause` event marks the gap. */
  pause(reason: string): void {
    if (!this.started) return;
    if (this.paused) return this.status('paused', reason);
    this.paused = true;
    this.end();
    this.marker('sq-pause', { reason });
    this.halt();
    this.segmenter.close();
    this.status('paused', reason);
  }

  /** Resumes with a full snapshot. */
  resume(): void {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.capture('resume');
  }

  /** pagehide: rrweb stops; in stream mode the open segment is handed back as the tail. */
  unload(): Segment & { stream: Stream } | null {
    if (!this.started) return null;
    this.end();
    this.halt();
    if (this.buffering) {
      this.segmenter.discard();
      this.ring.clear();
      return null;
    }
    const tail = this.segmenter.take();
    return tail && { ...tail, stream: this.stream };
  }

  /** Back from the back-forward cache, under a new page load. */
  restore(): void {
    if (this.started && !this.paused) this.capture('start');
  }

  /** The stream lost a snapshot: a fresh one, at most every RESYNC_MIN_MS. */
  resync(): void {
    this.schedule('resync');
  }

  private status(state: ReplayState, reason?: string): void {
    this.o.onStatus?.(state === 'recording' && this.buffering ? 'buffering' : state, reason);
  }

  /** rrweb and the refill tick stop; nothing more is captured. */
  private halt(): void {
    this.generation++;
    clearInterval(this.tick);
    try {
      this.stopRecord?.();
    } catch {
      // rrweb failing to stop must not keep us recording.
    }
    this.stopRecord = null;
  }

  private marker(tag: string, payload: Record<string, unknown>): void {
    try {
      this.o.record.addCustomEvent(tag, payload);
    } catch {
      // Not recording.
    }
  }

  private closed(s: Tagged): void {
    s.stream = this.stream;
    if (this.buffering) {
      this.ring.push(s);
      return;
    }
    this.o.onSegment(s, s.stream);
  }

  /** A streaming segment closed by age: a checkout is due once 3 minutes have passed. */
  private due(): void {
    if (!this.buffering && this.o.now() - this.snapshotAt >= CHECKOUT_EVERY_MS) this.schedule('checkout');
  }

  /** A checkout outside rrweb's own callback, like rrweb's own, after it returns. */
  private schedule(why: Why): void {
    if (why === 'resync') {
      // At most every RESYNC_MIN_MS; one asked for sooner waits for it (the refill tick).
      if (this.o.now() - this.resyncAt < RESYNC_MIN_MS) return void (this.resyncDue = true);
      this.resyncDue = false;
    }
    if (this.queued || !this.stopRecord) return;
    if (why === 'resync') this.resyncAt = this.o.now();
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.stopRecord) this.capture(why);
    });
  }

  /**
   * Restarts rrweb for a fresh snapshot. Unlike rrweb's own checkout, this leaves one set of
   * observers per iframe instead of one more each time.
   */
  private capture(why: Why): void {
    if (!this.started || this.paused) return;
    this.halt();
    this.segmenter.close();
    if (this.buffering) this.ring.begin();
    this.stream = this.o.stream();
    this.throttle.reset();
    this.resyncDue = false;
    this.why = why;
    this.ringLost = false;
    const generation = this.generation;
    const { record } = this.o;
    const { mirror } = record;
    const getNode: GetNode = (id) => mirror.getNode(id);
    let stop: (() => void) | undefined;
    try {
      stop = record({ ...this.options, emit: (event) => this.onEvent(event, generation, getNode) });
    } catch {
      stop = undefined;
    }
    // A snapshot too large to record has already stopped this recording.
    if (generation !== this.generation) return void stop?.();
    if (!stop) {
      this.started = false;
      return this.o.onStatus?.('stopped', 'record_failed');
    }
    this.stopRecord = stop;
    this.tick = setInterval(() => this.refill(generation), 1_000);
    this.status('recording');
  }

  /** Held node values come back once a second; a calm window after drops resyncs. */
  private refill(generation: number): void {
    if (generation !== this.generation) return;
    const { mirror } = this.o.record;
    const data = this.throttle.tick((id) => mirror.has(id));
    if (data) this.push({ type: INCREMENTAL, timestamp: this.o.now(), data: { source: MUTATION, ...data } }, true);
    this.calm();
    if (this.resyncDue) this.schedule('resync');
  }

  /** Throttled, and calm again or still hot after RESYNC_MIN_MS: mark the gap and resync. */
  private calm(): void {
    const t = this.o.now();
    if (!this.throttle.calm(t, RESYNC_MIN_MS) || t - this.resyncAt < RESYNC_MIN_MS) return;
    this.throttled();
    this.schedule('resync');
  }

  /** Recording pauses or ends: held node values go now, and a throttled run is marked. */
  private end(): void {
    if (!this.stopRecord) return;
    const { mirror } = this.o.record;
    const data = this.throttle.flush((id) => mirror.has(id));
    if (data) this.push({ type: INCREMENTAL, timestamp: this.o.now(), data: { source: MUTATION, ...data } }, true);
    this.throttled();
  }

  /** Marks where mutations were dropped (the player shows "simplified here"). */
  private throttled(): void {
    if (!this.throttle?.dropped) return;
    this.marker('sq-throttle', { dropped: this.throttle.dropped, since: this.throttle.since });
    this.throttle.reset();
  }

  private onEvent(event: unknown, generation: number, getNode: GetNode): void {
    if (generation !== this.generation) return;
    let e = withoutFrameContent(event, getNode) as { type?: number; timestamp?: number; data?: { source?: number } } | null;
    // Load markers can precede Meta while the document is still loading; they have no replay base.
    if (!e || e.type === 0 || e.type === 1) return;
    e.timestamp = this.o.now();
    const css: string[] = [];
    const snapshot = e.type === FULL_SNAPSHOT;
    cleanDomEvent(e, (a, node) => {
      if (!a) return;
      this.clean(a);
      const v = a._cssText;
      if (node && typeof v === 'string' && v.length > CSS_REF_MIN) {
        // Only a snapshot names a stylesheet the intake holds; anything else carries it inline.
        const ref = snapshot ? this.stream.css.ref(v) : null;
        if (ref) a._cssText = ref;
        else css.push(v);
      }
    });
    const mutation = e.type === INCREMENTAL && e.data?.source === MUTATION;
    if (mutation && !(e = this.throttle.node(e))) return;
    this.push(sanitizeReplayEvent(e, this.o.url), mutation, css);
  }

  private push(event: unknown, mutation: boolean, css?: string[]): void {
    if (this.ringLost) return;
    const e = event as { type: number; timestamp: number };
    const t = e.timestamp;
    let json: string;
    try {
      json = JSON.stringify(event);
    } catch {
      return;
    }
    const bytes = byteLength(json);
    if (e.type === FULL_SNAPSHOT && bytes > SNAPSHOT_MAX_BYTES) return this.tooLarge();
    if (mutation && !this.throttle.fits(t, bytes)) {
      this.o.count?.('replay_mutations_dropped');
      return;
    }
    this.segmenter.add({ json, bytes, type: e.type, t, css: css?.length ? css : undefined });
    if (this.buffering) {
      // The open snapshot is already a replacement base, so even the last closed run can go.
      this.ring.trim(this.segmenter.bytes + 2, this.segmenter.fs);
      if (this.ring.bytes + this.segmenter.bytes + 2 > RING_MAX_BYTES) {
        this.ring.clear();
        this.segmenter.discard();
        this.ringLost = true;
        this.schedule('checkout');
        return;
      }
    }
    // A page load's first snapshot goes at once, so a short view still plays. After a pause or a
    // loss, the snapshot's segment goes once it outgrows the unload path (gzip may not finish
    // before a close, and the rest builds on it); periodic checkouts wait for their segment.
    const s = this.segmenter;
    if (!this.buffering && s.fs && (this.why === 'start' || (this.why !== 'checkout' && s.bytes > KEEPALIVE_MAX_BYTES))) s.close();
    if (e.type === FULL_SNAPSHOT) {
      this.snapshotAt = t;
      this.sinceSnapshot = 0;
      return;
    }
    if (e.type === CUSTOM) return;
    this.sinceSnapshot += bytes;
    if (this.buffering && (t - this.snapshotAt >= BUFFER_CHECKOUT_MS || this.sinceSnapshot >= BUFFER_CHECKOUT_BYTES)) this.schedule('checkout');
    else if (mutation && this.throttle.dropped) this.calm();
  }

  /** The page is too large to record: nothing of this snapshot is sent, and replay stops. */
  private tooLarge(): void {
    this.halt();
    // The Meta event alone cannot play.
    this.segmenter.discard();
    if (this.buffering) this.ring.clear();
    this.started = false;
    console.warn('[SiteQwality RUM] Stopped session replay: this page is too large to record');
    this.o.onStatus?.('stopped', 'too_large');
  }
}
