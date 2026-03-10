const SESSION_KEY = 'sq_rum_session';
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const MAX_DURATION = 4 * 60 * 60 * 1000; // 4 hours

interface SessionData {
  id: string;
  started: number;
  lastActivity: number;
}

export class SessionManager {
  private sessionId = '';
  private startedAt = 0;
  private lastActivity = 0;

  constructor() {
    if (!this.restore()) {
      this.create();
    }
  }

  getSessionId(): string {
    if (this.isExpired()) {
      this.create();
    }
    this.lastActivity = Date.now();
    this.persist();
    return this.sessionId;
  }

  private isExpired(): boolean {
    const now = Date.now();
    return (
      now - this.lastActivity > INACTIVITY_TIMEOUT ||
      now - this.startedAt > MAX_DURATION
    );
  }

  private create(): void {
    this.sessionId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
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
      const data: SessionData = JSON.parse(raw);
      this.sessionId = data.id;
      this.startedAt = data.started;
      this.lastActivity = data.lastActivity;
      return !this.isExpired();
    } catch {
      return false;
    }
  }
}
