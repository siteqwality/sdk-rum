import { describe, it, expect, beforeEach, vi } from 'vitest';
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
