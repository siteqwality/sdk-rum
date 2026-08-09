import { describe, it, expect } from 'vitest';
import {
  evaluateFilters,
  type SessionState,
} from '../src/sampling/evaluator';
import type { SessionFilterRule } from '../src/types';

describe('evaluateFilters', () => {
  const baseState: SessionState = {
    hasError: false,
    errorCount: 0,
    pageCount: 1,
    actionCount: 0,
  };

  it('returns false when no rules match', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'error',
        conditions: { has_error: true },
        capture_replay: false,
      },
    ];
    const result = evaluateFilters(rules, { ...baseState });
    expect(result.captureDetail).toBe(false);
    expect(result.captureReplay).toBe(false);
  });

  it('matches error filter when session has errors', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'error',
        conditions: { has_error: true },
        capture_replay: false,
      },
    ];
    const result = evaluateFilters(rules, {
      ...baseState,
      hasError: true,
      errorCount: 1,
    });
    expect(result.captureDetail).toBe(true);
    expect(result.captureReplay).toBe(false);
  });

  it('activates replay when filter has capture_replay true', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'error',
        conditions: { has_error: true },
        capture_replay: true,
      },
    ];
    const result = evaluateFilters(rules, {
      ...baseState,
      hasError: true,
    });
    expect(result.captureDetail).toBe(true);
    expect(result.captureReplay).toBe(true);
  });

  it('matches slow_performance filter based on LCP', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'slow_performance',
        conditions: { lcp_gt_ms: 4000 },
        capture_replay: false,
      },
    ];
    const result = evaluateFilters(rules, {
      ...baseState,
      lcpMs: 5000,
    });
    expect(result.captureDetail).toBe(true);
  });

  it('does not match slow_performance when LCP is under threshold', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'slow_performance',
        conditions: { lcp_gt_ms: 4000 },
        capture_replay: false,
      },
    ];
    const result = evaluateFilters(rules, {
      ...baseState,
      lcpMs: 2000,
    });
    expect(result.captureDetail).toBe(false);
  });

  it('matches slow_performance filter based on CLS', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'slow_performance',
        conditions: { cls_gt: 0.25 },
        capture_replay: false,
      },
    ];
    const result = evaluateFilters(rules, {
      ...baseState,
      cls: 0.5,
    });
    expect(result.captureDetail).toBe(true);
  });

  it('matches custom filter with min_actions met', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'custom',
        conditions: { min_actions: 5 },
        capture_replay: false,
      },
    ];
    const result = evaluateFilters(rules, {
      ...baseState,
      actionCount: 10,
    });
    expect(result.captureDetail).toBe(true);
  });

  it('does not match custom filter when min_actions not met', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'custom',
        conditions: { min_actions: 5 },
        capture_replay: false,
      },
    ];
    const result = evaluateFilters(rules, {
      ...baseState,
      actionCount: 2,
    });
    expect(result.captureDetail).toBe(false);
  });

  it('does not match custom filter requiring user when no user set', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'custom',
        conditions: { has_user: true },
        capture_replay: true,
      },
    ];
    const result = evaluateFilters(rules, { ...baseState });
    expect(result.captureDetail).toBe(false);
    expect(result.captureReplay).toBe(false);
  });

  it('matches multiple rules: replay wins if any rule enables it', () => {
    const rules: SessionFilterRule[] = [
      {
        filter_type: 'error',
        conditions: {},
        capture_replay: false,
      },
      {
        filter_type: 'slow_performance',
        conditions: { lcp_gt_ms: 3000 },
        capture_replay: true,
      },
    ];
    const result = evaluateFilters(rules, {
      ...baseState,
      hasError: true,
      lcpMs: 4000,
    });
    expect(result.captureDetail).toBe(true);
    expect(result.captureReplay).toBe(true);
  });
});
