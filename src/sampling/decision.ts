import { hasRecorded } from '../replay/sequence';

const KEY_PREFIX = 'sq_rum_rules:';

/** What the recording rules decided for a session, kept across its page loads. */
export interface RuleDecision {
  detail: boolean;
  replay: boolean;
  actions: number;
}

// The stored decision for a session in this tab. Without one, a session 1.0.7
// recorded (sq_rum_replay_next:<sid>) resumes detail and replay.
export function loadDecision(sessionId: string): RuleDecision | null {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + sessionId);
    if (raw) {
      const data = JSON.parse(raw) as Record<string, unknown> | null;
      if (data && data.v === 1) {
        const actions = data.actions;
        return {
          detail: data.detail === true,
          replay: data.replay === true,
          actions: Number.isSafeInteger(actions) && (actions as number) >= 0 ? (actions as number) : 0,
        };
      }
    }
  } catch {
    // Unreadable storage or a corrupt value: fall through.
  }
  return hasRecorded(sessionId) ? { detail: true, replay: true, actions: 0 } : null;
}

export function saveDecision(sessionId: string, decision: RuleDecision): void {
  try {
    sessionStorage.setItem(
      KEY_PREFIX + sessionId,
      JSON.stringify({
        v: 1,
        detail: decision.detail,
        replay: decision.replay,
        actions: decision.actions,
      }),
    );
  } catch {
    // sessionStorage unavailable or full.
  }
}
