import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSession, encodeRec, decodeRec, isExpired, anonymousId, INACTIVITY_MS, MAX_SESSION_MS } from '../src/core/session';
import { clearStorage, settle } from './helpers/sdk';

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cookie = () => /(?:^|;\s*)_sq_s=([^;]*)/.exec(document.cookie)?.[1];

beforeEach(() => clearStorage());
afterEach(() => vi.useRealTimers());

describe('the session record', () => {
  it('round-trips id|started|lastActivity|decisions', () => {
    const rec = { id: '0199a6b2-7c3e-7f00-8a1b-1c2d3e4f5a6b', started: 1, last: 2, dec: { analyze: true, replay: true, rule_id: 'r_1f2e' } };
    expect(encodeRec(rec)).toBe('0199a6b2-7c3e-7f00-8a1b-1c2d3e4f5a6b|1|2|3:r_1f2e');
    expect(decodeRec(encodeRec(rec))).toEqual(rec);
    expect(decodeRec(encodeRec({ ...rec, dec: { analyze: false, replay: false } }))).toEqual({ ...rec, dec: { analyze: false, replay: false, rule_id: undefined } });
  });

  it('refuses malformed values', () => {
    for (const v of [null, '', 'x|1|2|0', '0199a6b2-7c3e-7f00-8a1b-1c2d3e4f5a6b|a|2|0', '0199a6b2-7c3e-7f00-8a1b-1c2d3e4f5a6b|1|2']) {
      expect(decodeRec(v)).toBeNull();
    }
  });

  it('expires after 15 min idle or 4 h', () => {
    const t = 10_000_000;
    const rec = { id: 'x', started: t, last: t, dec: { analyze: false, replay: false } };
    expect(isExpired(rec, t + INACTIVITY_MS)).toBe(false);
    expect(isExpired(rec, t + INACTIVITY_MS + 1)).toBe(true);
    expect(isExpired({ ...rec, last: t + MAX_SESSION_MS }, t + MAX_SESSION_MS + 1)).toBe(true);
  });
});

describe('createSession', () => {
  it('mints a UUIDv7 in the _sq_s cookie, shared by the next page load', () => {
    const a = createSession({ mode: 'persist' });
    expect(a.id).toMatch(UUID7);
    expect(a.mode).toBe('cookie');
    expect(a.isNew).toBe(true);
    expect(cookie()).toContain(a.id);
    const b = createSession({ mode: 'persist' });
    expect(b.id).toBe(a.id);
    expect(b.isNew).toBe(false);
  });

  it('falls back to localStorage when cookies do not stick, and to memory when nothing does', () => {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => {} });
    try {
      const s = createSession({ mode: 'persist' });
      expect(s.mode).toBe('local');
      expect(localStorage.getItem('_sq_s')).toContain(s.id);
      expect(createSession({ mode: 'persist', persistence: 'memory' }).mode).toBe('memory');
    } finally {
      Object.defineProperty(document, 'cookie', desc);
    }
  });

  it('persistence localStorage skips the cookie', () => {
    const s = createSession({ mode: 'persist', persistence: 'localStorage' });
    expect(s.mode).toBe('local');
    expect(cookie()).toBeUndefined();
  });

  it('cookieless mode keeps the session in this tab only, and memory mode stores nothing', () => {
    const s = createSession({ mode: 'session' });
    expect(s.mode).toBe('session');
    expect(sessionStorage.getItem('_sq_s')).toContain(s.id);
    expect(cookie()).toBeUndefined();
    clearStorage();
    const m = createSession({ mode: 'memory' });
    expect(m.mode).toBe('memory');
    expect(cookie()).toBeUndefined();
    expect(localStorage.length + sessionStorage.length).toBeLessThanOrEqual(1); // only the window id
  });

  it('rotates an expired session and adopts another tab’s live one', () => {
    vi.useFakeTimers({ now: Date.now() });
    const a = createSession({ mode: 'persist' });
    const first = a.id;
    vi.advanceTimersByTime(INACTIVITY_MS + 1);
    expect(a.expired()).toBe(true);
    a.rotate();
    expect(a.id).not.toBe(first);
    // Another tab replaces the cookie with an older live session: this tab adopts it.
    const other = '0199a6b2-7c3e-7f00-8a1b-1c2d3e4f5a6b';
    document.cookie = `_sq_s=${other}|${Date.now() - 1000}|${Date.now()}|1:r_x;path=/`;
    vi.advanceTimersByTime(1001);
    expect(a.sync()).toBe(true);
    expect(a.id).toBe(other);
    expect(a.decision).toEqual({ analyze: true, replay: false, rule_id: 'r_x' });
  });

  it('a busy tab keeps an idle tab’s session alive through the shared cookie', () => {
    vi.useFakeTimers({ now: Date.now() });
    const idle = createSession({ mode: 'persist' });
    const busy = createSession({ mode: 'persist' });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(5 * 60_000);
      busy.touch();
    }
    idle.sync(true);
    expect(idle.expired()).toBe(false);
    expect(idle.id).toBe(busy.id);
  });

  it('merges decisions written by another tab', () => {
    const a = createSession({ mode: 'persist' });
    const b = createSession({ mode: 'persist' });
    b.setDecision({ analyze: true, replay: true, rule_id: 'r_9' });
    a.sync(true);
    expect(a.decision).toEqual({ analyze: true, replay: true, rule_id: 'r_9' });
  });

  it('keeps the replay rule attribution when another tab upgrades an Analyze decision', () => {
    const a = createSession({ mode: 'persist' });
    a.setDecision({ analyze: true, replay: false, rule_id: 'r_analyze' });
    const b = createSession({ mode: 'persist' });
    b.setDecision({ analyze: true, replay: true, rule_id: 'r_replay' });
    a.sync(true);
    expect(a.decision).toEqual({ analyze: true, replay: true, rule_id: 'r_replay' });
    // A stale Analyze-only writer cannot overwrite a replay's attribution either.
    b.setDecision({ analyze: true, replay: false, rule_id: 'r_analyze' });
    a.sync(true);
    expect(a.decision).toEqual({ analyze: true, replay: true, rule_id: 'r_replay' });
  });

  it('adopts a 1.1 session and its rule decision on upgrade', () => {
    const id = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
    sessionStorage.setItem('sq_rum_session', JSON.stringify({ id, started: Date.now() - 1000, lastActivity: Date.now() }));
    sessionStorage.setItem(`sq_rum_rules:${id}`, JSON.stringify({ v: 1, detail: true, replay: true, actions: 3 }));
    const s = createSession({ mode: 'persist' });
    expect(s.id).toBe(id);
    expect(s.decision).toMatchObject({ analyze: true, replay: true });
    expect(cookie()).toContain(id);
  });

  it('moves stores keeping the id, and clear() removes every key', () => {
    const s = createSession({ mode: 'memory' });
    expect(cookie()).toBeUndefined();
    expect(s.setMode('persist')).toBe(false);
    expect(cookie()).toContain(s.id);
    anonymousId();
    localStorage.setItem('_sq_rcap', s.id);
    sessionStorage.setItem('_sq_rcap', s.id);
    s.clear();
    expect(cookie()).toBeUndefined();
    expect(localStorage.getItem('_sq_aid')).toBeNull();
    expect(localStorage.getItem('_sq_rcap')).toBeNull();
    expect(sessionStorage.getItem('_sq_rcap')).toBeNull();
  });

  it('a duplicated tab mints its own window id', async () => {
    const a = createSession({ mode: 'persist' });
    const original = a.windowId;
    const b = createSession({ mode: 'persist' });
    expect(b.windowId).toBe(original);
    await settle(2);
    // Exactly one side renamed (here both share a time origin, so the page load id decides).
    expect(b.windowId).not.toBe(a.windowId);
    expect([a.windowId, b.windowId]).toContain(original);
  });

  it('a back-forward cache restore is a new page load', () => {
    const s = createSession({ mode: 'persist' });
    const before = s.pageLoadId;
    s.newPageLoad();
    expect(s.pageLoadId).not.toBe(before);
  });
});

describe('anonymousId', () => {
  it('lasts 13 months in localStorage', () => {
    const id = anonymousId();
    expect(anonymousId()).toBe(id);
    localStorage.setItem('_sq_aid', `${id}|${Date.now() - 396 * 24 * 60 * 60_000}`);
    expect(anonymousId()).not.toBe(id);
  });
});
