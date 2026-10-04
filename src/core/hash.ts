// FNV-1a 32 over UTF-8 (shared with core-rs `common::rum::fingerprint::fnv1a32`) and ids.

export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  const add = (b: number) => {
    h = Math.imul(h ^ b, 0x01000193) >>> 0;
  };
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    // A lone surrogate encodes as U+FFFD, as TextEncoder does.
    if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
    if (c < 0x80) add(c);
    else if (c < 0x800) {
      add(0xc0 | (c >> 6));
      add(0x80 | (c & 63));
    } else if (c < 0x10000) {
      add(0xe0 | (c >> 12));
      add(0x80 | ((c >> 6) & 63));
      add(0x80 | (c & 63));
    } else {
      add(0xf0 | (c >> 18));
      add(0x80 | ((c >> 12) & 63));
      add(0x80 | ((c >> 6) & 63));
      add(0x80 | (c & 63));
    }
  }
  return h;
}

/** `hash / 2^32 < rate`, as core-rs `rule_sampled_in`. */
export const sampledIn = (key: string, rate: number): boolean => fnv1a32(key) / 4294967296 < rate;

export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const c = globalThis.crypto;
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function format(b: Uint8Array): string {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A v4 UUID; works on plain http pages where randomUUID is missing. */
export function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return format(b);
}

/** A v7 UUID: 48-bit epoch ms, then random bits, so ids sort by time. */
export function uuid7(ms: number = Date.now()): string {
  const b = randomBytes(16);
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return format(b);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
