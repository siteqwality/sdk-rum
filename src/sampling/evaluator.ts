import type { SessionFilterRule } from '../types';

export interface SessionState {
  hasError: boolean;
  errorCount: number;
  lcpMs?: number;
  fcpMs?: number;
  cls?: number;
  pageCount: number;
  actionCount: number;
  userId?: string;
}

export interface SamplingResult {
  captureDetail: boolean;
  captureReplay: boolean;
}

/** The keys a `custom` rule may hold; any other key makes it never match. */
export const CUSTOM_RULE_KEYS: readonly string[] = ['has_user', 'min_actions'];

/** Rules are ORed: any match captures detail, and replay if that rule asks for it. */
export function evaluateFilters(
  rules: readonly SessionFilterRule[],
  state: SessionState,
): SamplingResult {
  let captureDetail = false;
  let captureReplay = false;

  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule && matchesRule(rule, state)) {
      captureDetail = true;
      if (rule.capture_replay) captureReplay = true;
    }
  }

  return { captureDetail, captureReplay };
}

function matchesRule(rule: SessionFilterRule, state: SessionState): boolean {
  const c = rule.conditions;
  // Fail closed on a malformed rule.
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  switch (rule.filter_type) {
    case 'error':
      return state.hasError || (c.has_error === true && state.errorCount > 0);

    case 'slow_performance':
      return (
        (c.lcp_gt_ms != null &&
          state.lcpMs != null &&
          state.lcpMs > Number(c.lcp_gt_ms)) ||
        (c.cls_gt != null &&
          state.cls != null &&
          state.cls > Number(c.cls_gt))
      );

    case 'custom':
      // An unknown key is a condition this SDK cannot check, so it never matches.
      if (Object.keys(c).some((key) => !CUSTOM_RULE_KEYS.includes(key))) return false;
      if (c.has_user === true && !state.userId) return false;
      if (c.min_actions != null) {
        const min = Number(c.min_actions);
        if (!Number.isFinite(min) || state.actionCount < min) return false;
      }
      return true;

    default:
      return false;
  }
}
