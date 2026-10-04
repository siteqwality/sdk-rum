// Sessions (design 5.3): a UUIDv7 id in the first-party cookie `_sq_s`, shared by tabs, as
// `id|started|lastActivity|decisions`; localStorage, then memory, when cookies fail.
import { uuid, uuid7 } from './hash';
import { now, storage, isObj, isNum, on } from './util';

export const INACTIVITY_MS = 15 * 60_000;
export const MAX_SESSION_MS = 4 * 60 * 60_000;
const ACTIVITY_WRITE_MS = 5_000;
const ANON_TTL_MS = 395 * 24 * 60 * 60_000;
const KEY = '_sq_s';
const ANON = '_sq_aid';
const WINDOW = '_sq_w';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Decision {
  analyze: boolean;
  replay: boolean;
  rule_id?: string;
}

interface Rec {
  id: string;
  started: number;
  last: number;
  dec: Decision;
}

/** cookie and local persist across tabs; session is cookieless mode; memory persists nothing. */
export type StoreMode = 'cookie' | 'local' | 'session' | 'memory';

const none = (): Decision => ({ analyze: false, replay: false });

export function encodeRec(r: Rec): string {
  const flags = (r.dec.analyze ? 1 : 0) | (r.dec.replay ? 2 : 0);
  return `${r.id}|${r.started}|${r.last}|${flags}${r.dec.rule_id ? `:${encodeURIComponent(r.dec.rule_id)}` : ''}`;
}

export function decodeRec(v: string | null | undefined): Rec | null {
  const p = (v || '').split('|');
  const started = Number(p[1]);
  const last = Number(p[2]);
  if (p.length !== 4 || !ID.test(p[0]) || !isNum(started) || !isNum(last)) return null;
  const [flags, rule] = p[3].split(':');
  let rule_id: string | undefined;
  try {
    rule_id = rule ? decodeURIComponent(rule) : undefined;
  } catch {
    rule_id = undefined;
  }
  return { id: p[0].toLowerCase(), started, last, dec: { analyze: (+flags & 1) > 0, replay: (+flags & 2) > 0, rule_id } };
}

export const isExpired = (r: Rec, t: number = now()): boolean =>
  t - r.last > INACTIVITY_MS || t - r.started > MAX_SESSION_MS || t < r.started - 60_000;

function cookieText(): string {
  try {
    return document.cookie;
  } catch {
    return '';
  }
}

function readCookie(): string | null {
  const m = new RegExp(`(?:^|;\\s*)${KEY}=([^;]*)`).exec(cookieText());
  return m ? m[1] : null;
}

/** A 1.1 session in this tab (sessionStorage), adopted so an upgrade never splits it. */
function legacy(): Rec | null {
  try {
    const s = JSON.parse(storage.get('sessionStorage', 'sq_rum_session') || 'null');
    if (!isObj(s) || typeof s.id !== 'string' || !ID.test(s.id) || !isNum(s.started) || !isNum(s.lastActivity)) return null;
    const rules = JSON.parse(storage.get('sessionStorage', `sq_rum_rules:${s.id}`) || 'null');
    const recorded = Number(storage.get('sessionStorage', `sq_rum_replay_next:${s.id}`)) > 0;
    const dec = isObj(rules) && rules.v === 1
      ? { analyze: rules.detail === true, replay: rules.replay === true }
      : { analyze: recorded, replay: recorded };
    return { id: s.id.toLowerCase(), started: s.started, last: s.lastActivity, dec };
  } catch {
    return null;
  }
}

export interface SessionOptions {
  persistence?: 'cookie' | 'localStorage' | 'memory';
  cookieDomain?: string;
  /** The store to start in: memory while consent is pending, session when cookieless. */
  mode: 'persist' | 'session' | 'memory';
}

export type Session = ReturnType<typeof createSession>;

export function createSession(opts: SessionOptions) {
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? ';Secure' : '';
  const domain = opts.cookieDomain ? `;domain=${opts.cookieDomain}` : '';
  let mode: StoreMode = 'memory';
  let rec: Rec;
  let isNew = false;
  let lastRead = 0;
  let lastWrite = 0;

  const writeCookie = (v: string, maxAge: number, name = KEY) => {
    try {
      document.cookie = `${name}=${v};path=/;max-age=${maxAge};SameSite=Lax${secure}${domain}`;
    } catch {
      // Cookies blocked.
    }
  };

  function read(): Rec | null {
    if (mode === 'cookie') return decodeRec(readCookie());
    if (mode === 'local') return decodeRec(storage.get('localStorage', KEY));
    if (mode === 'session') return decodeRec(storage.get('sessionStorage', KEY));
    return null;
  }

  function write(): void {
    lastWrite = now();
    const v = encodeRec(rec);
    if (mode === 'cookie') writeCookie(v, MAX_SESSION_MS / 1000);
    else if (mode === 'local') storage.set('localStorage', KEY, v);
    else if (mode === 'session') storage.set('sessionStorage', KEY, v);
  }

  /** Picks the store for `target`, falling back when a write does not stick. */
  function pick(target: SessionOptions['mode']): StoreMode {
    if (target === 'memory') return 'memory';
    if (target === 'session') return works('sessionStorage') ? 'session' : 'memory';
    if (opts.persistence !== 'memory' && opts.persistence !== 'localStorage') {
      writeCookie('1', 10, '_sq_t');
      const ok = /(?:^|;\s*)_sq_t=1/.test(cookieText());
      writeCookie('', 0, '_sq_t');
      if (ok) return 'cookie';
    }
    return opts.persistence !== 'memory' && works('localStorage') ? 'local' : 'memory';
  }

  function works(kind: 'localStorage' | 'sessionStorage'): boolean {
    const ok = storage.set(kind, '_sq_t', '1');
    storage.del(kind, '_sq_t');
    return ok;
  }

  function create(t: number): void {
    rec = { id: uuid7(t), started: t, last: t, dec: none() };
    isNew = true;
    write();
  }

  mode = pick(opts.mode);
  const stored = read();
  const t0 = now();
  if (stored && !isExpired(stored, t0)) rec = stored;
  else {
    const old = legacy();
    if (old && !isExpired(old, t0)) {
      rec = old;
      write();
    } else create(t0);
  }

  // Window id per tab; a duplicated tab copies sessionStorage, so the later page load renames.
  // Stored only once the session may be (never while consent is pending).
  let windowId = storage.get('sessionStorage', WINDOW) || '';
  const saveWindow = () => mode !== 'memory' && storage.set('sessionStorage', WINDOW, windowId);
  if (!ID.test(windowId)) {
    windowId = uuid();
    saveWindow();
  }
  let pageLoadId = uuid();
  const origin = typeof performance !== 'undefined' ? performance.timeOrigin || t0 : t0;
  try {
    const channel = new BroadcastChannel('_sq_rum');
    const hello = () => channel.postMessage({ w: windowId, p: pageLoadId, o: origin });
    const answered = new Set<string>();
    channel.onmessage = (e: MessageEvent) => {
      const m = e.data as { w?: string; p?: string; o?: number } | null;
      if (!m || m.w !== windowId || !m.p || m.p === pageLoadId) return;
      // The later page load is the copy; ties break on the page load id, so one side renames.
      if ((m.o ?? 0) < origin || (m.o === origin && m.p < pageLoadId)) {
        windowId = uuid();
        saveWindow();
      } else if (!answered.has(m.p)) {
        answered.add(m.p);
        hello();
      }
    };
    hello();
  } catch {
    // No BroadcastChannel: duplicated tabs share a window id.
  }

  return {
    get id() {
      return rec.id;
    },
    get started() {
      return rec.started;
    },
    /** True when this page load created the session (its first view carries referrer and UTM). */
    get isNew() {
      return isNew;
    },
    get decision(): Decision {
      return rec.dec;
    },
    get windowId() {
      return windowId;
    },
    get pageLoadId() {
      return pageLoadId;
    },
    get mode() {
      return mode;
    },
    newPageLoad() {
      pageLoadId = uuid();
    },
    expired: (t?: number) => isExpired(rec, t),
    /** Reads the shared store; true when another tab's session was adopted. */
    sync(force = false): boolean {
      const t = now();
      if (!force && t - lastRead < 1000) return false;
      lastRead = t;
      const s = read();
      if (!s) {
        if (mode !== 'memory' && !isExpired(rec, t)) write();
        return false;
      }
      if (s.id === rec.id) {
        rec.last = Math.max(rec.last, s.last);
        rec.dec = {
          analyze: rec.dec.analyze || s.dec.analyze,
          replay: rec.dec.replay || s.dec.replay,
          rule_id: rec.dec.rule_id || s.dec.rule_id,
        };
        return false;
      }
      const theirs = !isExpired(s, t);
      const mine = !isExpired(rec, t);
      if (theirs && (!mine || s.started < rec.started || (s.started === rec.started && s.id < rec.id))) {
        rec = s;
        isNew = false;
        return true;
      }
      if (mine) write();
      return false;
    },
    rotate() {
      create(now());
    },
    /** User activity, written at most every 5 s. */
    touch() {
      const t = now();
      rec.last = t;
      if (t - lastWrite >= ACTIVITY_WRITE_MS) write();
    },
    setDecision(d: Decision) {
      rec.dec = d;
      write();
    },
    /** Moves the session to another store, keeping its id unless the store holds a live one. */
    setMode(target: SessionOptions['mode']): boolean {
      const next = pick(target);
      if (next === mode) return false;
      mode = next;
      saveWindow();
      const s = read();
      if (s && s.id !== rec.id && !isExpired(s)) {
        rec = s;
        isNew = false;
        return true;
      }
      write();
      return false;
    },
    /** Removes every key the SDK stores but the opt-out (consent withdrawn). */
    clear() {
      for (const k of [KEY, '_sq_rl', '_sq_rseq']) writeCookie('', 0, k);
      for (const kind of ['localStorage', 'sessionStorage'] as const) {
        for (const k of ['s', 'aid', 'w', 'bgt', 'bgr', 'act', 'rseq', 'rl'].map((k) => `_sq_${k}`).concat('sq_rum_session', `sq_rum_rules:${rec.id}`, `sq_rum_replay_next:${rec.id}`)) storage.del(kind, k);
      }
    },
  };
}

/** The anonymous visitor id (localStorage `_sq_aid`, 13 months). */
export function anonymousId(): string | undefined {
  const t = now();
  const [id, created] = (storage.get('localStorage', ANON) || '').split('|');
  if (ID.test(id) && t - Number(created) < ANON_TTL_MS) return id;
  const fresh = uuid();
  return storage.set('localStorage', ANON, `${fresh}|${t}`) ? fresh : undefined;
}

/** pageshow from the back-forward cache. */
export function onRestore(fn: () => void): void {
  on(window, 'pageshow', (e: PageTransitionEvent) => {
    if (e.persisted) fn();
  });
}
