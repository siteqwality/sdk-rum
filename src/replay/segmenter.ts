// Segments (design 5.5, 6.4) and the replay ring (5.4). A segment is a run of serialized rrweb
// events with the index fields `/v2/segments` takes; the ring holds the last two checkouts.

// rrweb discriminants, pinned against rrweb's enums by replay-url.test.ts.
export const FULL_SNAPSHOT = 2;
export const INCREMENTAL = 3;
export const META = 4;
export const CUSTOM = 5;

/** A segment closes once its first event is this old (stream mode). */
export const SEGMENT_MAX_AGE_MS = 20_000;
/** Raw JSON a segment aims for (about 512 KB gzip); a single larger event goes alone. */
export const SEGMENT_MAX_BYTES = 2_500_000;
/** The ring keeps at most this much serialized replay; past it the older checkout goes. */
export const RING_MAX_BYTES = 5_000_000;
/** A held checkout older than this at the trigger is stale, and dropped. */
export const RING_STALE_MS = 120_000;

export interface Segment {
  json: string[];
  /** UTF-16 length of the events joined by commas: bytes for ASCII, a cheap bound otherwise. */
  bytes: number;
  /** First and last event times (epoch ms). */
  ft: number;
  lt: number;
  /** Holds a full snapshot, which the page load's later segments build on. */
  fs: boolean;
  /** Stylesheets carried inline; the intake holds them once this segment is acknowledged. */
  css: string[];
  /** What it holds in memory: `bytes` plus the stylesheet texts kept for acknowledgement. */
  mem: number;
}

export interface Entry {
  json: string;
  type: number;
  t: number;
  css?: string[];
}

interface Open extends Segment {
  metaFirst: boolean;
}

export class Segmenter {
  private open: Open | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `maxAge` Infinity holds segments open until a snapshot or the byte cap (buffer mode). */
  constructor(
    private out: (s: Segment) => void,
    public maxAge = SEGMENT_MAX_AGE_MS,
    private onAge: () => void = () => {},
  ) {}

  add(e: Entry): void {
    // A Meta event opens a segment; its full snapshot stays with it.
    if (e.type === META) this.close();
    const size = e.json.length + 1;
    const o = this.open;
    if (o && o.bytes + size > SEGMENT_MAX_BYTES && !(e.type === FULL_SNAPSHOT && o.metaFirst && o.json.length === 1)) this.close();
    if (!this.open) {
      this.open = { json: [], bytes: -1, ft: e.t, lt: e.t, fs: false, css: [], mem: -1, metaFirst: e.type === META };
      if (this.maxAge < Infinity) this.timer = setTimeout(() => (this.close(), this.onAge()), this.maxAge);
    }
    const s = this.open!;
    s.json.push(e.json);
    s.bytes += size;
    s.mem += size;
    s.lt = Math.max(s.lt, e.t);
    s.ft = Math.min(s.ft, e.t);
    if (e.type === FULL_SNAPSHOT) s.fs = true;
    for (const c of e.css ?? []) s.css.push(c), (s.mem += c.length);
  }

  /** Closes the open segment, handing it out. */
  close(): void {
    const s = this.take();
    if (s) this.out(s);
  }

  /** Closes the open segment and returns it instead (the unload tail). */
  take(): Segment | null {
    clearTimeout(this.timer);
    const s = this.open;
    this.open = null;
    if (!s) return null;
    const { metaFirst, ...segment } = s;
    void metaFirst;
    return segment;
  }

  /** Drops the open segment unsent. */
  discard(): void {
    clearTimeout(this.timer);
    this.open = null;
  }

  get bytes(): number {
    return this.open ? this.open.bytes : 0;
  }

  get mem(): number {
    return this.open ? this.open.mem : 0;
  }

  /** The open segment holds a full snapshot. */
  get fs(): boolean {
    return !!this.open?.fs;
  }

  get empty(): boolean {
    return !this.open;
  }
}

/**
 * Buffer mode (design 5.4): closed segments grouped into checkouts. It keeps the current and
 * the previous one within RING_MAX_BYTES; on a rule match they go out, oldest first.
 */
export class Ring {
  private runs: Segment[][] = [];
  private held = 0;

  push(s: Segment): void {
    if (s.fs || !this.runs.length) this.runs.push([s]);
    else this.runs[this.runs.length - 1].push(s);
    this.held += s.mem;
    while (this.runs.length > 2) this.dropOldest();
  }

  /** A checkout begins: only the one before it stays. */
  begin(): void {
    while (this.runs.length > 1) this.dropOldest();
  }

  /** Over the cap with `extra` more on the way: the older checkout goes. */
  trim(extra = 0): void {
    while (this.runs.length > 1 && this.held + extra > RING_MAX_BYTES) this.dropOldest();
  }

  /**
   * Everything held, oldest first, without checkouts that ended before `staleBefore`. The last
   * stays when `keepLast`: later events build on it.
   */
  take(staleBefore: number, keepLast = true): Segment[] {
    const runs = this.runs.filter((r, i) => (keepLast && i === this.runs.length - 1) || r[r.length - 1].lt >= staleBefore);
    this.clear();
    return runs.flat();
  }

  clear(): void {
    this.runs = [];
    this.held = 0;
  }

  get bytes(): number {
    return this.held;
  }

  private dropOldest(): void {
    for (const s of this.runs.shift() ?? []) this.held -= s.mem;
  }
}
