// Opt-in pixels, encoded as rrweb's native bitmap commands. No application context is patched.
import type { SdkConfig } from '../types';
import { canvasBudget, CANVAS_MAX_BYTES } from './canvas-budget';

// Only identities survive checkouts. Weak keys retain neither detached DOM nor pixel data.
const canvasKeys = new WeakMap<HTMLCanvasElement, number>();
let nextCanvasKey = 0;

export interface CanvasOptions {
  config: unknown;
  privacy: SdkConfig['privacy'];
  session: string;
  store?: 'localStorage' | 'sessionStorage';
  mirror: { getIds(): number[]; getNode(id: number): Node | null; getId(node: Node): number };
  now(): number;
  emit(event: unknown): void;
  count?: (name: string, n?: number) => void;
}

/** Reject invalid selectors rather than widening a capture or block list. */
export function normalizeCanvas(raw: unknown, privacy: SdkConfig['privacy']) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || privacy.level === 'strict') return null;
  const c = raw as Record<string, unknown>;
  if (c.enabled !== true) return null;
  const selectors = c.selectors === undefined ? [] : c.selectors;
  if (!Array.isArray(selectors) || selectors.some(s => typeof s !== 'string' || !s.trim())) return null;
  try {
    for (const s of [...selectors, ...privacy.block_selectors]) document.documentElement.matches(s);
  } catch { return null; }
  const number = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return { selectors: selectors as string[], block: ['.rr-block', '[data-sq-block]', ...privacy.block_selectors].join(','), fps: number(c.fps, 2, 1, 2), quality: number(c.quality, 0.4, 0.2, 0.4) };
}

export function frameEvent(id: number, timestamp: number, base64: string, width: number, height: number) {
  return { type: 3, timestamp, data: { source: 9, type: 0, id, commands: [
    { property: 'clearRect', args: [0, 0, width, height] },
    { property: 'drawImage', args: [{ rr_type: 'ImageBitmap', args: [{ rr_type: 'Blob', data: [{ rr_type: 'ArrayBuffer', base64 }], type: 'image/webp' }] }, 0, 0, width, height] },
  ] } };
}

const base64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

export function startCanvas(o: CanvasOptions): () => void {
  const cfg = normalizeCanvas(o.config, o.privacy);
  const budget = canvasBudget(o.session, o.store, o.now);
  if (!cfg || !budget.available || typeof IntersectionObserver !== 'function') return () => {};
  let alive = true;
  let raf = 0;
  let last = -Infinity;
  let ready = false;
  let capped = false;
  const bound = new WeakMap<HTMLCanvasElement, number>();
  const visible = new WeakSet<Element>();
  const observed = new Set<HTMLCanvasElement>();
  const busy = new WeakSet<HTMLCanvasElement>();
  const observer = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0) visible.add(e.target); else visible.delete(e.target);
  });
  const stop = () => { alive = false; cancelAnimationFrame(raf); observer.disconnect(); observed.clear(); };
  const allowed = (canvas: HTMLCanvasElement, pixels = true) => {
    if (!alive || !canvas.isConnected || canvas.ownerDocument !== document || document.visibilityState === 'hidden' || (pixels && !visible.has(canvas))) return false;
    if (!canvas.width || !canvas.height || (cfg.selectors.length && !cfg.selectors.some(s => canvas.matches(s)))) return false;
    for (let el: Element | null = canvas; el; el = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null) {
      if (el.matches(cfg.block)) return false;
      const css = getComputedStyle(el);
      if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || css.opacity === '0') return false;
    }
    return true;
  };
  const bind = (canvas: HTMLCanvasElement, allocate = false) => {
    const id = o.mirror.getId(canvas);
    if (id < 0 || bound.get(canvas) === id || !allowed(canvas, false)) return;
    let key = canvasKeys.get(canvas);
    if (!key && allocate) canvasKeys.set(canvas, key = ++nextCanvasKey);
    if (!key) return;
    bound.set(canvas, id);
    o.emit({ type: 5, timestamp: o.now(), data: { tag: 'sq-canvas-ref', payload: { id, key } } });
  };
  const cap = () => {
    capped = true;
    o.count?.('canvas_cap');
    o.emit({ type: 5, timestamp: o.now(), data: { tag: 'sq-canvas-cap', payload: { limit: CANVAS_MAX_BYTES, bytes: budget.used } } });
  };
  // Reopening a capped session must not even read its pixels. A final tick still binds old IDs.
  void budget.reserve(0, () => alive).then(result => {
    if (!alive) return;
    if (result === 'cap') cap();
    else if (result === 'ok') ready = true;
    else { o.count?.('canvas_unavailable'); stop(); }
  });
  const capture = async (canvas: HTMLCanvasElement) => {
    if (busy.has(canvas) || !allowed(canvas)) return;
    busy.add(canvas);
    const width = canvas.width, height = canvas.height, id = o.mirror.getId(canvas);
    const active = () => allowed(canvas) && o.mirror.getId(canvas) === id && canvas.width === width && canvas.height === height;
    try {
      if (id < 0) return;
      const scale = Math.min(1, 1280 / Math.max(width, height));
      const image = document.createElement('canvas');
      image.width = Math.max(1, Math.round(width * scale)); image.height = Math.max(1, Math.round(height * scale));
      const ctx = image.getContext('2d');
      if (!ctx) return;
      // Copy synchronously in this animation frame, before WebGL's drawing buffer is discarded.
      ctx.drawImage(canvas, 0, 0, image.width, image.height);
      const timestamp = o.now();
      const blob = await new Promise<Blob | null>(resolve => image.toBlob(resolve, 'image/webp', cfg.quality));
      if (!blob || blob.type !== 'image/webp' || !active()) return;
      const event = frameEvent(id, timestamp, await base64(blob), width, height);
      if (!active()) return;
      const result = await budget.reserve(JSON.stringify(event).length, active); // All fields are ASCII.
      if (!active()) return;
      if (result === 'ok') { bind(canvas, true); o.emit(event); }
      else {
        if (result === 'cap') cap();
        else o.count?.('canvas_unavailable');
        stop();
      }
    } catch {
      // Tainted, lost-context and unsupported canvases do not affect the host or other canvases.
      o.count?.('canvas_frame_dropped');
    } finally { busy.delete(canvas); }
  };
  const tick = (at: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(tick);
    if (at - last < 1000 / cfg.fps) return;
    last = at;
    const canvases = new Set(o.mirror.getIds().map(id => o.mirror.getNode(id)).filter((n): n is HTMLCanvasElement => n instanceof HTMLCanvasElement && n.ownerDocument === document));
    for (const c of observed) if (!canvases.has(c)) { observer.unobserve(c); observed.delete(c); }
    for (const c of canvases) {
      bind(c);
      if (!observed.has(c)) { observed.add(c); observer.observe(c); }
      if (ready && !capped) void capture(c);
    }
    if (capped) stop();
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
