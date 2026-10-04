import { uuid } from './uuid';

const SESSION_KEY = 'sq_rum_session';
export const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_SESSION_MS = 4 * 60 * 60 * 1000;
// The intake rejects a batch whose session id is not a UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionData {
  id: string;
  started: number;
  lastActivity: number;
}

// The session id, per tab in sessionStorage. Only `activity()` (input, a visible
// tab, a view start) extends it; the SDK's own emits never do.
export class SessionManager {
  private sessionId = '';
  private startedAt = 0;
  private lastActivity = 0;
  private rotateListeners: Array<() => void> = [];

  constructor() {
    if (!this.restore()) this.create();
  }

  /** The current id, with no expiry check and no activity refresh. */
  current(): string {
    return this.sessionId;
  }

  isExpired(now: number = Date.now()): boolean {
    return (
      now - this.lastActivity > INACTIVITY_TIMEOUT_MS ||
      now - this.startedAt > MAX_SESSION_MS
    );
  }

  /** User activity: rotates an expired session, then refreshes it. */
  activity(): string {
    if (this.isExpired()) {
      this.rotate();
    } else {
      this.lastActivity = Date.now();
      this.persist();
    }
    return this.sessionId;
  }

  /** The id an emitted event carries: rotates an expired session first. */
  idForEmit(): string {
    if (this.isExpired()) this.rotate();
    return this.sessionId;
  }

  /** @deprecated Alias of `idForEmit()`. */
  getSessionId(): string {
    return this.idForEmit();
  }

  /** Called after each rotation, once the new id is in place. */
  onRotate(listener: () => void): void {
    this.rotateListeners.push(listener);
  }

  private rotate(): void {
    this.create();
    for (const listener of this.rotateListeners) {
      try {
        listener();
      } catch {
        // A listener must not stop the others.
      }
    }
  }

  private create(): void {
    this.sessionId = uuid();
    this.startedAt = Date.now();
    this.lastActivity = this.startedAt;
    this.persist();
  }

  private persist(): void {
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          id: this.sessionId,
          started: this.startedAt,
          lastActivity: this.lastActivity,
        } satisfies SessionData),
      );
    } catch {
      // sessionStorage unavailable (SSR, private browsing, etc.)
    }
  }

  private restore(): boolean {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw) as Partial<SessionData> | null;
      if (
        !data ||
        typeof data.id !== 'string' ||
        !UUID.test(data.id) ||
        !Number.isFinite(data.started) ||
        !Number.isFinite(data.lastActivity)
      ) {
        return false;
      }
      this.sessionId = data.id;
      this.startedAt = data.started as number;
      this.lastActivity = data.lastActivity as number;
      return !this.isExpired();
    } catch {
      return false;
    }
  }
}
