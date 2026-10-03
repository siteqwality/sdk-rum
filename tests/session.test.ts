import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../src/session';

describe('SessionManager', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('creates a new session on first access', () => {
    const manager = new SessionManager();
    const id = manager.getSessionId();
    expect(id).toBeTruthy();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('returns the same session id on subsequent calls', () => {
    const manager = new SessionManager();
    const id1 = manager.getSessionId();
    const id2 = manager.getSessionId();
    expect(id1).toBe(id2);
  });

  it('restores session from sessionStorage', () => {
    const manager1 = new SessionManager();
    const id1 = manager1.getSessionId();

    const manager2 = new SessionManager();
    const id2 = manager2.getSessionId();
    expect(id2).toBe(id1);
  });

  it('creates a new session after inactivity timeout (15 min)', () => {
    const manager = new SessionManager();
    const id1 = manager.getSessionId();

    // Simulate 16 minutes of inactivity
    const stored = JSON.parse(sessionStorage.getItem('sq_rum_session')!);
    stored.lastActivity = Date.now() - 16 * 60 * 1000;
    sessionStorage.setItem('sq_rum_session', JSON.stringify(stored));

    const manager2 = new SessionManager();
    const id2 = manager2.getSessionId();
    expect(id2).not.toBe(id1);
  });

  it('creates a new session after max duration (4 hours)', () => {
    const manager = new SessionManager();
    const id1 = manager.getSessionId();

    // Simulate 4+ hours since session start
    const stored = JSON.parse(sessionStorage.getItem('sq_rum_session')!);
    stored.started = Date.now() - 4.1 * 60 * 60 * 1000;
    stored.lastActivity = Date.now(); // recent activity, but session too old
    sessionStorage.setItem('sq_rum_session', JSON.stringify(stored));

    const manager2 = new SessionManager();
    const id2 = manager2.getSessionId();
    expect(id2).not.toBe(id1);
  });
});

describe('SessionManager activity', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const MIN = 60_000;

  it('current() never rotates or refreshes', () => {
    const manager = new SessionManager();
    const id = manager.current();
    vi.advanceTimersByTime(20 * MIN);
    expect(manager.current()).toBe(id);
    expect(manager.isExpired()).toBe(true);
  });

  it('idForEmit() rotates an expired session but does not refresh a live one', () => {
    const manager = new SessionManager();
    const id = manager.current();
    vi.advanceTimersByTime(10 * MIN);
    expect(manager.idForEmit()).toBe(id);
    vi.advanceTimersByTime(6 * MIN);
    const next = manager.idForEmit();
    expect(next).not.toBe(id);
    expect(manager.getSessionId()).toBe(next);
  });

  it('activity() refreshes, and rotates first once expired', () => {
    const manager = new SessionManager();
    const id = manager.current();
    vi.advanceTimersByTime(14 * MIN);
    expect(manager.activity()).toBe(id);
    vi.advanceTimersByTime(14 * MIN);
    expect(manager.activity()).toBe(id);
    vi.advanceTimersByTime(16 * MIN);
    expect(manager.activity()).not.toBe(id);
  });

  it('persists activity for the next page load', () => {
    const manager = new SessionManager();
    vi.advanceTimersByTime(14 * MIN);
    manager.activity();
    vi.advanceTimersByTime(14 * MIN);
    expect(new SessionManager().current()).toBe(manager.current());
  });

  it('calls onRotate listeners after the new id is in place, even if one throws', () => {
    const manager = new SessionManager();
    const seen: string[] = [];
    manager.onRotate(() => {
      throw new Error('listener bug');
    });
    manager.onRotate(() => seen.push(manager.current()));
    const old = manager.current();
    vi.advanceTimersByTime(16 * MIN);
    manager.idForEmit();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(old);
  });

  it('starts fresh from a corrupt or non-UUID stored session', () => {
    for (const raw of ['{', 'null', JSON.stringify({ id: 'x', started: 1, lastActivity: 1 }), JSON.stringify({ id: crypto.randomUUID() })]) {
      sessionStorage.setItem('sq_rum_session', raw);
      const id = new SessionManager().current();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(id).not.toBe('x');
    }
  });
});
