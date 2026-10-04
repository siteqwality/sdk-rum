// What replay may record (design 7.1): rrweb privacy options from the app's level and selectors,
// URL minimisation and PII scrubbing of DOM attributes, and no content from inside iframes.
import type { UrlSanitizer } from '../core/url';
import type { SdkConfig } from '../types';
import type { record as rrwebRecord } from '@rrweb/record';
import { FULL_SNAPSHOT as RRWEB_FULL_SNAPSHOT_EVENT_TYPE, INCREMENTAL as RRWEB_INCREMENTAL_EVENT_TYPE, META as RRWEB_META_EVENT_TYPE } from './segmenter';

const RRWEB_MUTATION_SOURCE = 0;
const RRWEB_DOCUMENT_NODE_TYPE = 0;

/** Elements whose content and attributes replay never records. */
export const HIDDEN_INPUT_SELECTOR = 'input[type="hidden" i]';

export type RecordFn = typeof rrwebRecord;
type RecordOptions = NonNullable<Parameters<RecordFn>[0]>;
export type GetNode = (id: number) => unknown;

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
 * DOM attribute URLs are minimised separately, by `cleanAttributes`.
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

export type ReplayState = 'buffering' | 'recording' | 'paused' | 'stopped';

const STRICT_MEDIA = ['img', 'video', 'audio', 'picture', 'svg'];

function valid(list: string[]): string | undefined {
  const probe = document.createElement('div');
  return (
    list
      .filter((s) => {
        try {
          probe.matches(s);
          return true;
        } catch {
          return false;
        }
      })
      .join(',') || undefined
  );
}

/** rrweb privacy from the app's level and selectors (design 7.1); block selectors always win. */
export function replayPrivacy(p: SdkConfig['privacy'], mask: (s: string) => string): ReplayPrivacy {
  const strict = p.level === 'strict';
  return {
    maskInputs: p.level !== null || p.mask_inputs,
    maskAllText: strict || p.mask_text,
    maskSelector: valid(p.mask_selectors),
    unmaskSelector: strict ? valid(p.unmask_selectors) : undefined,
    blockSelector: valid([...p.block_selectors, ...(strict ? STRICT_MEDIA : [])]) ?? '',
    ignoreSelector: valid(p.ignore_input_selectors),
    scrub: p.pii_patterns.length ? mask : undefined,
  };
}


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
    // Design 5.5: input keeps the last value, media events at most every 800 ms.
    sampling: { mousemove: 50, scroll: 150, input: 'last', media: 800 },
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

// url(...), quoted or not, and @import "...": where URLs live in CSS.
const CSS_URL = /(url\(\s*)(?:(["'])(.*?)\2|([^'")\s]*))(\s*\))|(@import\s+)(["'])(.*?)\7/gis;
const cssCache = new Map<string, string>();

/**
 * URLs in CSS minimised, nothing else touched: fragment references (`url(#clip)`) and data URIs
 * are kept, and each value is rewritten in place, so a declaration never loses its neighbours.
 */
export function cleanCss(css: string, url: UrlSanitizer): string {
  if (!/url\(|@import/i.test(css)) return css;
  const hit = cssCache.get(css);
  if (hit !== undefined) return hit;
  const clean = (v: string) => (!v || v[0] === '#' || /^data:/i.test(v) ? v : url(v));
  const out = css.replace(CSS_URL, (m, pre, q, quoted, bare, post, imp, iq, iv) =>
    imp ? `${imp}${iq}${clean(iv)}${iq}` : `${pre}${q ? `${q}${clean(quoted)}${q}` : clean(bare)}${post}`,
  );
  // Checkouts serialize the same large sheets again; a few are remembered.
  if (css.length > 1024) {
    if (cssCache.size >= 8) cssCache.delete(cssCache.keys().next().value!);
    cssCache.set(css, out);
  }
  return out;
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
    if (name.startsWith('rr_')) continue;
    // Stylesheets: URLs minimised, nothing scrubbed (digit runs live in fonts and selectors).
    if (name === '_cssText') {
      if (typeof v === 'string') attrs[name] = text(cleanCss(v, url));
      continue;
    }
    if (typeof v === 'string') {
      let out = URL_ATTRS.includes(name.toLowerCase())
        ? url(v)
        : name === 'srcset'
          ? v.split(',').map((part) => part.trim().replace(/^\S+/, (u) => url(u))).join(', ')
          : text(name === 'style' ? cleanCss(v, url) : v);
      if (scrub) out = scrub(out);
      attrs[name] = out;
    } else if (v && typeof v === 'object') {
      // A style diff: property to value or [value, priority].
      for (const [k, sv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof sv === 'string') (v as Record<string, unknown>)[k] = text(cleanCss(sv, url));
      }
    }
  }
}

function cleanNode(n: SerializedNode | undefined, clean: Visit): void {
  if (!n) return;
  clean(n.attributes, true);
  if (Array.isArray(n.childNodes)) for (const c of n.childNodes) cleanNode(c, clean);
}

type Visit = (a: Record<string, unknown> | undefined, node: boolean) => void;


/**
 * Visits the DOM attributes of full snapshots and mutations, which `clean` may rewrite in place.
 * `node` is true for serialized nodes, false for attribute changes.
 */
export function cleanDomEvent(event: unknown, clean: Visit): void {
  const e = event as { type?: number; data?: { node?: SerializedNode; source?: number; adds?: Array<{ node?: SerializedNode }>; attributes?: Array<{ attributes?: Record<string, unknown> }> } } | null;
  const d = e?.data;
  if (!d) return;
  if (e.type === RRWEB_FULL_SNAPSHOT_EVENT_TYPE) cleanNode(d.node, clean);
  else if (e.type === RRWEB_INCREMENTAL_EVENT_TYPE && d.source === RRWEB_MUTATION_SOURCE) {
    for (const a of d.adds ?? []) cleanNode(a.node, clean);
    for (const a of d.attributes ?? []) clean(a.attributes, false);
  }
}

