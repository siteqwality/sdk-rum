import { describe, it, expect } from 'vitest';
import { MutationThrottle, NODE_BUCKET, NODE_REFILL, WINDOW_BYTES, WINDOW_MS } from '../src/replay/throttle';

type Mutation = {
  adds?: unknown[];
  removes?: Array<{ id: number; parentId?: number }>;
  texts?: Array<{ id: number; value: string | null }>;
  attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
};
const ev = (data: Mutation) => ({ type: 3, timestamp: 0, data: { source: 0, adds: [], removes: [], texts: [], attributes: [], ...data } });
const text = (id: number, value: string) => ev({ texts: [{ id, value }] });
const attr = (id: number, attributes: Record<string, unknown>) => ev({ attributes: [{ id, attributes }] });
const alive = () => true;

describe('per-node throttle', () => {
  it('lets a node change NODE_BUCKET times, then holds its changes', () => {
    const t = new MutationThrottle();
    for (let i = 0; i < NODE_BUCKET; i++) expect(t.node(text(7, `v${i}`))).not.toBeNull();
    expect(t.node(text(7, 'held'))).toBeNull();
    expect(t.coalesced).toBe(1);
    // Other nodes are unaffected.
    expect(t.node(text(8, 'other'))).not.toBeNull();
  });

  it('brings the latest held value back as one mutation a second', () => {
    const t = new MutationThrottle();
    for (let i = 0; i < NODE_BUCKET; i++) t.node(text(7, `v${i}`));
    for (let i = 0; i < 50; i++) t.node(text(7, `late${i}`));
    t.node(attr(7, { class: 'a' }));
    t.node(attr(7, { class: 'b', 'data-x': '1' }));
    expect(t.tick(alive)).toEqual({ adds: [], removes: [], texts: [{ id: 7, value: 'late49' }], attributes: [{ id: 7, attributes: { class: 'b', 'data-x': '1' } }] });
    expect(t.tick(alive)).toBeNull();
  });

  it('caps a hot node at the refill rate, about NODE_REFILL changes a second', () => {
    const t = new MutationThrottle();
    let passed = 0;
    for (let s = 0; s < 10; s++) {
      for (let f = 0; f < 60; f++) if (t.node(text(1, `${s}.${f}`))) passed++;
      if (t.tick(alive)) passed++;
    }
    // The first second spends the bucket; then about NODE_REFILL a second.
    expect(passed).toBeGreaterThanOrEqual(NODE_BUCKET + 9 * (NODE_REFILL - 1));
    expect(passed).toBeLessThanOrEqual(NODE_BUCKET + 10 * NODE_REFILL);
  });

  it('merges style diffs and keeps the order when a diff meets a held string', () => {
    const t = new MutationThrottle();
    for (let i = 0; i < NODE_BUCKET; i++) t.node(attr(3, { style: { opacity: String(i) } }));
    t.node(attr(3, { style: { opacity: '0.5' } }));
    t.node(attr(3, { style: { color: 'red' } }));
    expect(t.tick(alive)!.attributes).toEqual([{ id: 3, attributes: { style: { opacity: '0.5', color: 'red' } } }]);

    const u = new MutationThrottle();
    for (let i = 0; i < NODE_BUCKET; i++) u.node(attr(4, { style: 'opacity: 0' }));
    u.node(attr(4, { style: 'opacity: 1' }));
    const out = u.node(attr(4, { style: { color: 'blue' } }));
    expect(out!.data.attributes).toEqual([
      { id: 4, attributes: { style: 'opacity: 1' } },
      { id: 4, attributes: { style: { color: 'blue' } } },
    ]);
  });

  it('forgets held values of a node that was removed or re-added', () => {
    const t = new MutationThrottle();
    for (let i = 0; i < NODE_BUCKET; i++) t.node(text(5, 'x'));
    t.node(text(5, 'held'));
    t.node(ev({ removes: [{ id: 5, parentId: 1 }] }));
    expect(t.tick(alive)).toBeNull();

    for (let i = 0; i < NODE_BUCKET; i++) t.node(text(6, 'x'));
    t.node(text(6, 'stale'));
    t.node(ev({ adds: [{ parentId: 1, nextId: null, node: { id: 2, type: 2, childNodes: [{ id: 6, type: 3 }] } }] }));
    expect(t.tick(alive)).toBeNull();
  });

  it('drops held values for nodes no longer on the page', () => {
    const t = new MutationThrottle();
    for (let i = 0; i < NODE_BUCKET; i++) t.node(text(9, 'x'));
    t.node(text(9, 'held'));
    expect(t.tick(() => false)).toBeNull();
  });

  it("shares an svg's bucket among its children", () => {
    const t = new MutationThrottle((id) => (id >= 100 ? 99 : id));
    for (let i = 0; i < NODE_BUCKET; i++) t.node(attr(100 + (i % 10), { d: `M${i}` }));
    expect(t.node(attr(150, { d: 'M0' }))).toBeNull();
  });

  it('flush releases everything held, tokens or not', () => {
    const t = new MutationThrottle();
    for (let i = 0; i < NODE_BUCKET; i++) t.node(text(1, 'x'));
    t.node(text(1, 'last'));
    expect(t.flush(alive)!.texts).toEqual([{ id: 1, value: 'last' }]);
    expect(t.flush(alive)).toBeNull();
  });

  it('passes a mutation with no text or attribute changes through untouched', () => {
    const t = new MutationThrottle();
    const e = ev({ adds: [{ parentId: 1, nextId: null, node: { id: 2 } }] });
    expect(t.node(e)).toBe(e);
  });
});

describe('global mutation window', () => {
  it('admits WINDOW_BYTES per WINDOW_MS, then drops and counts', () => {
    const t = new MutationThrottle();
    let kept = 0;
    for (let ms = 0; ms < WINDOW_MS; ms += 10) if (t.fits(ms, 4096)) kept += 4096;
    expect(kept).toBeLessThanOrEqual(WINDOW_BYTES);
    expect(kept).toBeGreaterThan(WINDOW_BYTES - 4096);
    expect(t.dropped).toBeGreaterThan(0);
    expect(t.since).toBeGreaterThan(0);
  });

  it('a burst passes whole into an empty window, even one larger than the window', () => {
    const t = new MutationThrottle();
    expect(t.fits(0, 300 * 1024)).toBe(true);
    expect(t.fits(WINDOW_MS, WINDOW_BYTES * 2)).toBe(true);
    expect(t.fits(WINDOW_MS, 1)).toBe(false);
    expect(t.dropped).toBe(1);
  });

  it('is calm once drops stop and the window falls under half', () => {
    const t = new MutationThrottle();
    while (t.fits(0, 10_000));
    expect(t.calm(1_000)).toBe(false);
    expect(t.calm(WINDOW_MS)).toBe(true);
    t.reset();
    expect(t.calm(WINDOW_MS * 2)).toBe(false);
  });
});
