import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCanvas, frameEvent, startCanvas } from '../src/replay/canvas';
import { canvasBudget, CANVAS_MAX_BYTES } from '../src/replay/canvas-budget';
import { normalizeConfig } from '../src/core/config';

const privacy = () => normalizeConfig(null, 'app').privacy;
let frames: unknown[];
let raf: FrameRequestCallback | undefined;
let time: number;
let canvas: HTMLCanvasElement;
let blob: Blob;
let encode: ReturnType<typeof vi.fn>;
let draw: ReturnType<typeof vi.fn>;
let stop: (() => void) | undefined;
let visible: (el: Element, shown: boolean) => void;

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); frames = []; time = 0;
  document.body.innerHTML = '<canvas width="2560" height="1280"></canvas>';
  canvas = document.querySelector('canvas')!;
  blob = new Blob(['webp'], { type: 'image/webp' });
  draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as never);
  encode = vi.fn(function(this: HTMLCanvasElement, cb: BlobCallback) { cb(blob); });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(encode);
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => (raf = cb, 1)));
  vi.stubGlobal('cancelAnimationFrame', vi.fn(() => { raf = undefined; }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: IntersectionObserverCallback) { visible = (el, shown) => cb([{ target: el, isIntersecting: shown, intersectionRatio: shown ? 1 : 0 } as IntersectionObserverEntry], this as never); }
    observe(el: Element) { visible(el, true); }
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 50 } as DOMRect);
});
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const options = (extra = {}) => ({ config: { enabled: true, selectors: [], fps: 2, quality: 0.4 }, privacy: privacy(), session: crypto.randomUUID(), store: undefined, mirror: { getIds: () => [7], getNode: () => canvas, getId: () => 7 }, now: () => time, emit: (e: unknown) => frames.push(e), ...extra });
async function tick(t: number) { time = t; await Promise.resolve(); raf?.(t); await new Promise(r => setTimeout(r, 10)); }
const pixels = () => frames.filter((e: any) => e.type === 3);

describe('canvas config and frames', () => {
  it('keeps opt-in configuration for the lazy module; no config means no canvas', () => {
    expect(normalizeConfig(null, 'app').capture.canvas).toBeNull();
    expect(normalizeConfig({ capture: { canvas: { enabled: true, selectors: ['canvas.chart'] } } }, 'app').capture.canvas).toEqual({ enabled: true, selectors: ['canvas.chart'] });
  });
  it.each([null, {}, { enabled: false }, { enabled: 'true' }, { enabled: true, selectors: ['['] }, { enabled: true, selectors: [1] }])('fails closed for %j', raw => expect(normalizeCanvas(raw, privacy())).toBeNull());
  it('always disables Strict, and rejects invalid block selectors', () => {
    expect(normalizeCanvas({ enabled: true }, { ...privacy(), level: 'strict' })).toBeNull();
    expect(normalizeCanvas({ enabled: true }, { ...privacy(), block_selectors: ['['] })).toBeNull();
  });
  it('caps backend settings to the approved recorder diet', () => {
    expect(normalizeCanvas({ enabled: true, fps: 4, quality: 0.8 }, privacy())).toMatchObject({ fps: 2, quality: 0.4 });
  });
  it('uses the native rrweb bitmap contract with original canvas dimensions', () => {
    const e = frameEvent(7, 10, 'YWJj', 2560, 1280);
    expect(e).toMatchObject({ type: 3, timestamp: 10, data: { source: 9, type: 0, id: 7 } });
    expect(e.data.commands[1]).toMatchObject({ property: 'drawImage', args: [{ rr_type: 'ImageBitmap', args: [{ rr_type: 'Blob', type: 'image/webp', data: [{ rr_type: 'ArrayBuffer', base64: 'YWJj' }] }] }, 0, 0, 2560, 1280] });
  });
});

describe('canvas capture lifecycle', () => {
  it('samples at most 2 fps and downsizes before WebP encoding', async () => {
    stop = startCanvas(options());
    await tick(0); await tick(100); await tick(499); await tick(500);
    expect(pixels()).toHaveLength(2);
    expect(draw.mock.calls[0]).toEqual([canvas, 0, 0, 1280, 640]);
    expect(encode.mock.calls[0].slice(1)).toEqual(['image/webp', 0.4]);
  });
  it('never reads pixels without opt-in or under Strict', async () => {
    stop = startCanvas(options({ config: null })); await tick(0);
    stop(); stop = startCanvas(options({ privacy: { ...privacy(), level: 'strict' } })); await tick(500);
    expect(draw).not.toHaveBeenCalled(); expect(frames).toEqual([]);
  });
  it('honors selection and blocked ancestors before reading pixels', async () => {
    canvas.className = 'private';
    stop = startCanvas(options({ privacy: { ...privacy(), block_selectors: ['.private'] } })); await tick(0);
    expect(draw).not.toHaveBeenCalled();
    stop(); stop = startCanvas(options({ config: { enabled: true, selectors: ['.chosen'] } })); await tick(500);
    expect(draw).not.toHaveBeenCalled();
  });
  it('pauses off-screen canvases and samples again when visible', async () => {
    stop = startCanvas(options()); await tick(0); visible(canvas, false); await tick(500);
    expect(pixels()).toHaveLength(1); visible(canvas, true); await tick(1000); expect(pixels()).toHaveLength(2);
  });
  it('blocks a mirrored canvas inside a private shadow host', async () => {
    const host = document.createElement('div');
    host.className = 'private'; document.body.append(host);
    host.attachShadow({ mode: 'open' }).append(canvas);
    stop = startCanvas(options({ privacy: { ...privacy(), block_selectors: ['.private'] } }));
    await tick(0);
    expect(draw).not.toHaveBeenCalled(); expect(frames).toEqual([]);
  });
  it.each(['remove', 'resize', 'mirror'] as const)('drops an asynchronous frame after %s', async change => {
    let done!: BlobCallback; let id = 7;
    encode.mockImplementation((cb: BlobCallback) => { done = cb; });
    stop = startCanvas(options({ mirror: { getIds: () => [id], getNode: () => canvas, getId: () => id } }));
    await tick(0);
    if (change === 'remove') canvas.remove();
    else if (change === 'resize') canvas.width++;
    else id++;
    done(blob); await new Promise(r => setTimeout(r, 10));
    expect(frames).toEqual([]);
  });
  it('drops an encode completed after stop', async () => {
    let done!: BlobCallback; encode.mockImplementation((cb: BlobCallback) => { done = cb; });
    stop = startCanvas(options()); await tick(0); stop(); done(blob); await tick(1000);
    expect(frames).toEqual([]);
  });
  it('rechecks privacy after an asynchronous encode', async () => {
    let done!: BlobCallback; encode.mockImplementation((cb: BlobCallback) => { done = cb; });
    stop = startCanvas(options({ privacy: { ...privacy(), block_selectors: ['.private'] } })); await tick(0);
    canvas.className = 'private'; done(blob); await tick(500); expect(frames).toEqual([]);
  });
  it('contains taint errors and never emits PNG fallback bytes', async () => {
    draw.mockImplementationOnce(() => { throw new DOMException('tainted', 'SecurityError'); });
    stop = startCanvas(options()); await tick(0); expect(frames).toEqual([]);
    blob = new Blob(['png'], { type: 'image/png' }); await tick(500); expect(frames).toEqual([]);
  });
  it('rebinds the last frame after a capped checkout without reading more pixels', async () => {
    const session = crypto.randomUUID(); let id = 7;
    const o = options({ session, store: 'sessionStorage', mirror: { getIds: () => [id], getNode: () => canvas, getId: () => id } });
    stop = startCanvas(o); await tick(0);
    const ref = (frames as any[]).find(e => e.data?.tag === 'sq-canvas-ref');
    expect(ref.data.payload.id).toBe(7);
    stop(); frames = []; id = 8;
    sessionStorage.setItem('_sq_cb', JSON.stringify([[session, { bytes: CANVAS_MAX_BYTES, capped: true, expires: 14_400_000 }]]));
    stop = startCanvas(o); await tick(500);
    expect(draw).toHaveBeenCalledTimes(1); expect(pixels()).toEqual([]);
    expect(frames).toContainEqual(expect.objectContaining({ data: { tag: 'sq-canvas-ref', payload: { id: 8, key: ref.data.payload.key } } }));
    expect(frames).toContainEqual(expect.objectContaining({ data: { tag: 'sq-canvas-cap', payload: { limit: CANVAS_MAX_BYTES, bytes: CANVAS_MAX_BYTES } } }));
    stop(); frames = []; canvas.className = 'rr-block';
    stop = startCanvas(o); await tick(1000);
    expect((frames as any[]).some(e => e.data?.tag === 'sq-canvas-ref')).toBe(false);
    expect(draw).toHaveBeenCalledTimes(1);
  });
});

describe('canvas session accounting', () => {
  it('caps serialized bytes across restarts and resets only for a different session', async () => {
    const id = crypto.randomUUID(); const a = canvasBudget(id);
    expect(await a.reserve(CANVAS_MAX_BYTES - 1, () => true)).toBe('ok');
    expect(await canvasBudget(id).reserve(2, () => true)).toBe('cap');
    expect(await a.reserve(1, () => true)).toBe('cap');
    expect(await canvasBudget(crypto.randomUUID()).reserve(1, () => true)).toBe('ok');
  });
  it('serializes shared reservations and persists the exhausted session', async () => {
    let queue = Promise.resolve();
    vi.stubGlobal('navigator', { locks: { request: (_: string, f: () => unknown) => { const next = queue.then(f); queue = next.then(() => undefined); return next; } } });
    const a = canvasBudget('shared', 'localStorage'); const b = canvasBudget('shared', 'localStorage');
    expect(await Promise.all([a.reserve(12_000_000, () => true), b.reserve(12_000_000, () => true)])).toEqual(['ok', 'cap']);
    expect(await canvasBudget('shared', 'localStorage').reserve(1, () => true)).toBe('cap');
  });
  it('a stale session cannot reset another session counter during rotation', async () => {
    const old = canvasBudget('old', 'sessionStorage');
    const next = canvasBudget('next', 'sessionStorage');
    expect(await old.reserve(CANVAS_MAX_BYTES - 1, () => true)).toBe('ok');
    expect(await next.reserve(CANVAS_MAX_BYTES - 1, () => true)).toBe('ok');
    expect(await old.reserve(2, () => true)).toBe('cap');
    expect(await next.reserve(2, () => true)).toBe('cap');
  });
  it('expires obsolete counters only after the maximum session lifetime', async () => {
    let now = 0;
    const old = canvasBudget('expired', 'sessionStorage', () => now);
    await old.reserve(1, () => true);
    now = 14_400_001;
    await canvasBudget('current', 'sessionStorage', () => now).reserve(1, () => true);
    expect(JSON.parse(sessionStorage.getItem('_sq_cb')!).map((e: [string, unknown]) => e[0])).toEqual(['current']);
  });
  it('fails closed without shared locking, and never writes after consent withdrawal', async () => {
    vi.stubGlobal('navigator', {});
    expect(await canvasBudget('shared', 'localStorage').reserve(1, () => true)).toBe('unavailable');
    expect(await canvasBudget('cancelled', 'sessionStorage').reserve(1, () => false)).toBe('unavailable');
    expect(sessionStorage.length).toBe(0);
  });
  it('does not recreate storage when a queued Web Lock is granted after stop', async () => {
    let grant!: () => void;
    vi.stubGlobal('navigator', { locks: { request: (_: string, f: () => unknown) => new Promise(resolve => { grant = () => resolve(f()); }) } });
    let active = true;
    const reservation = canvasBudget('pending', 'localStorage').reserve(100, () => active);
    active = false; localStorage.clear(); grant();
    expect(await reservation).toBe('unavailable'); expect(localStorage.length).toBe(0);
  });
  it('fails closed when storage access fails or the persisted counter is corrupt', async () => {
    sessionStorage.setItem('_sq_cb', JSON.stringify([['corrupt', { bytes: -1, capped: false, expires: Date.now() + 1000 }]]));
    expect(await canvasBudget('corrupt', 'sessionStorage').reserve(1, () => true)).toBe('unavailable');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    expect(await canvasBudget('quota', 'sessionStorage').reserve(1, () => true)).toBe('unavailable');
  });
});
