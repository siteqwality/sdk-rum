// Mutation throttle (design 5.5). Per node: a token bucket on attribute and text changes, with
// held values coalesced into one mutation a second so the final state stays exact. Globally: a
// 5 s window of serialized mutation bytes; past it whole mutations drop and a checkout resyncs.

/** Per-node bucket size and refill per second (PostHog's tested values). */
export const NODE_BUCKET = 100;
export const NODE_REFILL = 10;
/** Global budget: 64 KB of serialized mutations a second, averaged over 5 s. */
export const WINDOW_MS = 5_000;
export const WINDOW_BYTES = 5 * 64 * 1024;

type Attrs = Record<string, unknown>;

interface Mutation {
  adds?: Array<{ node?: SerializedNode }>;
  removes?: Array<{ id?: number }>;
  texts?: Array<{ id: number; value: string | null }>;
  attributes?: Array<{ id: number; attributes: Attrs }>;
}

interface SerializedNode {
  id?: number;
  childNodes?: SerializedNode[];
}

interface Held {
  /** The bucket it draws from: the node, or the svg it belongs to. */
  key: number;
  text?: string | null;
  hasText?: boolean;
  attrs?: Attrs;
}

const isObj = (v: unknown): v is Attrs => !!v && typeof v === 'object' && !Array.isArray(v);

/** Later values win; a style diff merges into a held diff, anything else replaces it. */
function merge(held: Attrs, next: Attrs): boolean {
  for (const [k, v] of Object.entries(next)) {
    const was = held[k];
    if (isObj(v) && was !== undefined && !isObj(was)) return false;
    held[k] = isObj(v) && isObj(was) ? { ...was, ...v } : v;
  }
  return true;
}

export class MutationThrottle {
  private buckets = new Map<number, number>();
  private held = new Map<number, Held>();
  private sizes: number[] = [];
  private times: number[] = [];
  private head = 0;
  private inWindow = 0;
  /** Mutation events dropped by the global budget since the last resync, and when the first was. */
  dropped = 0;
  since = 0;
  /** Changes held back by node buckets, in all. */
  coalesced = 0;

  /** `key` maps a node to its bucket (an svg's children share the svg's). */
  constructor(private key: (id: number) => number = (id) => id) {}

  /** Filters hot nodes' changes out of a mutation into the held set; null when nothing is left. */
  node<T extends { data?: unknown }>(event: T): T | null {
    const d = event.data as Mutation;
    if (this.held.size) {
      for (const r of d.removes ?? []) if (r.id !== undefined) this.held.delete(r.id);
      // A re-added node carries its current state; older held values would overwrite it.
      const forget = (n?: SerializedNode) => {
        if (!n) return;
        if (n.id !== undefined) this.held.delete(n.id);
        n.childNodes?.forEach(forget);
      };
      for (const a of d.adds ?? []) forget(a.node);
    }
    if (!d.texts?.length && !d.attributes?.length) return event;
    const texts: NonNullable<Mutation['texts']> = [];
    const attributes: NonNullable<Mutation['attributes']> = [];
    const coalesced = this.coalesced;
    for (const t of d.texts ?? []) {
      const h = this.hold(t.id);
      if (!h) texts.push(t);
      else (h.text = t.value), (h.hasText = true);
    }
    for (const a of d.attributes ?? []) {
      const h = this.hold(a.id);
      if (!h) attributes.push(a);
      else if (!h.attrs) h.attrs = { ...a.attributes };
      else if (!merge(h.attrs, a.attributes)) {
        // A held string style cannot take a diff: the held state goes first, then the change.
        this.held.delete(a.id);
        if (h.hasText) texts.push({ id: a.id, value: h.text ?? null });
        attributes.push({ id: a.id, attributes: h.attrs }, a);
      }
    }
    if (coalesced === this.coalesced) return event;
    if (!texts.length && !attributes.length && !d.adds?.length && !d.removes?.length) return null;
    return { ...event, data: { ...d, texts, attributes } };
  }

  /** Null when the change may pass (a token taken); else the node's held state to fold it into. */
  private hold(id: number): Held | null {
    const key = this.key(id);
    const left = this.buckets.get(key) ?? NODE_BUCKET;
    let h = this.held.get(id);
    if (left > 0 && !h) {
      this.buckets.set(key, left - 1);
      return null;
    }
    if (!h) this.held.set(id, (h = { key }));
    this.coalesced++;
    return h;
  }

  /**
   * The one-second refill: buckets refill, and held values of nodes with tokens again come
   * back as one mutation. `alive` drops values for nodes no longer on the page.
   */
  tick(alive: (id: number) => boolean): Mutation | null {
    for (const [k, v] of this.buckets) {
      if (v + NODE_REFILL >= NODE_BUCKET) this.buckets.delete(k);
      else this.buckets.set(k, v + NODE_REFILL);
    }
    return this.release(alive, false);
  }

  /** Every held value at once, tokens or not (recording pauses or ends). */
  flush(alive: (id: number) => boolean): Mutation | null {
    return this.release(alive, true);
  }

  private release(alive: (id: number) => boolean, all: boolean): Mutation | null {
    const texts: NonNullable<Mutation['texts']> = [];
    const attributes: NonNullable<Mutation['attributes']> = [];
    for (const [id, h] of this.held) {
      const left = this.buckets.get(h.key) ?? NODE_BUCKET;
      if (left <= 0 && !all) continue;
      this.held.delete(id);
      if (!alive(id)) continue;
      if (left > 0) this.buckets.set(h.key, left - 1);
      if (h.hasText) texts.push({ id, value: h.text ?? null });
      if (h.attrs) attributes.push({ id, attributes: h.attrs });
    }
    return texts.length || attributes.length ? { adds: [], removes: [], texts, attributes } : null;
  }

  /** Whether a mutation of `bytes` fits the global window at `t`; a drop is counted. */
  fits(t: number, bytes: number): boolean {
    this.prune(t);
    // Into an empty window anything fits, so a route change larger than the window still plays.
    if (this.inWindow && this.inWindow + bytes > WINDOW_BYTES) {
      if (!this.dropped++) this.since = t;
      return false;
    }
    this.sizes.push(bytes);
    this.times.push(t);
    this.inWindow += bytes;
    return true;
  }

  /**
   * Time for one resync checkout: drops happened and the window is back under half, or drops
   * have gone on for `stale` ms (a page that never calms must not diverge for long).
   */
  calm(t: number, stale = Infinity): boolean {
    this.prune(t);
    return this.dropped > 0 && (this.inWindow < WINDOW_BYTES / 2 || t - this.since >= stale);
  }

  private prune(t: number): void {
    while (this.head < this.times.length && t - this.times[this.head] >= WINDOW_MS) this.inWindow -= this.sizes[this.head++];
    if (this.head > 1024) {
      this.sizes = this.sizes.slice(this.head);
      this.times = this.times.slice(this.head);
      this.head = 0;
    }
  }

  /** A fresh snapshot carries the true state: nothing held, nothing dropped. */
  reset(): void {
    this.held.clear();
    this.buckets.clear();
    this.dropped = 0;
    this.since = 0;
  }
}
