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

export function evaluateFilters(
  rules: SessionFilterRule[],
  state: SessionState,
): SamplingResult {
  let captureDetail = false;
  let captureReplay = false;

  for (const rule of rules) {
    if (matchesRule(rule, state)) {
      captureDetail = true;
      if (rule.capture_replay) captureReplay = true;
    }
  }

  return { captureDetail, captureReplay };
}

function matchesRule(rule: SessionFilterRule, state: SessionState): boolean {
  const c = rule.conditions;
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
      if (c.has_user === true && !state.userId) return false;
      if (
        c.min_actions != null &&
        state.actionCount < Number(c.min_actions)
      )
        return false;
      return true;

    default:
      return false;
  }
}
