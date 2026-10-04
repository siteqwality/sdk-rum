import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRules, holds } from '../src/core/rules';
import type { RecordingRule } from '../src/types';
import type { Decision } from '../src/core/session';

const SID = '0199a6b2-7c3e-7f00-8a1b-1c2d3e4f5a6b';
const facts = { device: 'desktop' as const, release: '1.4.2', env: 'production' };
const none: Decision = { analyze: false, replay: false };

function rule(capture: 'analyze' | 'replay', conditions: RecordingRule['conditions'] = [], extra: Partial<RecordingRule> = {}): RecordingRule {
  return { id: `r_${Math.random().toString(16).slice(2, 8)}`, capture, sample_rate: 1, conditions, min_duration_ms: 0, require_interaction: false, ...extra };
}

function setup(rules: RecordingRule[], started = Date.now(), stored = none) {
  const decisions: Decision[] = [];
  const r = createRules(facts, (d) => decisions.push({ ...d }));
  r.set(rules, SID, started, stored, true);
  return { r, decisions };
}

afterEach(() => vi.useRealTimers());

describe('conditions', () => {
  const f = facts;
  it('url: contains, starts_with (path or URL), regex', () => {
    const i = { k: 'url' as const, url: 'https://shop.test/checkout/pay', path: '/checkout/pay' };
    expect(holds({ kind: 'url', op: 'contains', value: 'checkout' }, i, f)).toBe(true);
    expect(holds({ kind: 'url', op: 'starts_with', value: '/checkout' }, i, f)).toBe(true);
    expect(holds({ kind: 'url', op: 'starts_with', value: 'https://shop.test/c' }, i, f)).toBe(true);
    expect(holds({ kind: 'url', op: 'regex', value: '^/checkout/(pay|ship)$' }, i, f)).toBe(true);
    expect(holds({ kind: 'url', op: 'regex', value: '(' }, i, f)).toBe(false);
    expect(holds({ kind: 'url', op: 'contains', value: '' }, i, f)).toBe(false);
  });

  it('error: type, message and unhandled only', () => {
    const e = { k: 'error' as const, type: 'TypeError', message: 'card is null', handling: 'handled' };
    expect(holds({ kind: 'error' }, e, f)).toBe(true);
    expect(holds({ kind: 'error', error_type: 'TypeError', message_contains: 'card' }, e, f)).toBe(true);
    expect(holds({ kind: 'error', error_type: 'RangeError' }, e, f)).toBe(false);
    expect(holds({ kind: 'error', unhandled_only: true }, e, f)).toBe(false);
  });

  it('network_error, frustration, vital, event, identified, attribute', () => {
    expect(holds({ kind: 'network_error', status_class: '5xx' }, { k: 'network_error', status: 503, url: 'u' }, f)).toBe(true);
    expect(holds({ kind: 'network_error', status_class: 'network', url_contains: '/api' }, { k: 'network_error', status: 0, url: 'https://x/api/a' }, f)).toBe(true);
    expect(holds({ kind: 'network_error', status_class: '4xx' }, { k: 'network_error', status: 503, url: 'u' }, f)).toBe(false);
    expect(holds({ kind: 'frustration', type: 'rage_click' }, { k: 'frustration', type: 'rage_click' }, f)).toBe(true);
    expect(holds({ kind: 'vital', metric: 'lcp', gt: 2500 }, { k: 'vital', metric: 'lcp', value: 4000 }, f)).toBe(true);
    expect(holds({ kind: 'vital', metric: 'lcp', gt: 2500 }, { k: 'vital', metric: 'lcp', value: 1000 }, f)).toBe(false);
    expect(holds({ kind: 'event', name: 'checkout' }, { k: 'event', name: 'checkout' }, f)).toBe(true);
    expect(holds({ kind: 'identified' }, { k: 'identified' }, f)).toBe(true);
    expect(holds({ kind: 'attribute', key: 'plan', value: 'pro' }, { k: 'attribute', key: 'plan', value: 'pro' }, f)).toBe(true);
  });

  it('device, release and env are facts of the page', () => {
    expect(holds({ kind: 'device', class: 'desktop' }, null, f)).toBe(true);
    expect(holds({ kind: 'device', class: 'mobile' }, null, f)).toBe(false);
    expect(holds({ kind: 'release', op: 'starts_with', value: '1.4' }, null, f)).toBe(true);
    expect(holds({ kind: 'release', op: 'eq', value: '1.4.2' }, null, f)).toBe(true);
    expect(holds({ kind: 'env', value: 'production' }, null, f)).toBe(true);
  });

  it('an unknown kind never holds', () => {
    expect(holds({ kind: 'mystery' }, { k: 'identified' }, f)).toBe(false);
  });
});

describe('evaluation', () => {
  it('an empty rule matches on arrival; replay implies analyze', () => {
    const { r, decisions } = setup([rule('replay')]);
    expect(r.decision).toMatchObject({ analyze: true, replay: true });
    expect(decisions).toHaveLength(1);
  });

  it('all conditions of a rule must hold, at any time in the session; any rule matches', () => {
    const { r } = setup([rule('analyze', [{ kind: 'url', op: 'contains', value: '/checkout' }, { kind: 'error' }]), rule('analyze', [{ kind: 'event', name: 'x' }])]);
    r.input({ k: 'error', type: 'Error', message: 'm', handling: 'unhandled' });
    expect(r.decision.analyze).toBe(false);
    r.input({ k: 'url', url: 'https://s/checkout', path: '/checkout' });
    expect(r.decision.analyze).toBe(true);
  });

  it('rules arriving later see inputs that already happened', () => {
    const decisions: Decision[] = [];
    const r = createRules(facts, (d) => decisions.push(d));
    r.set([], SID, Date.now(), none, true);
    r.input({ k: 'error', type: 'Error', message: 'early', handling: 'unhandled' });
    r.set([rule('replay', [{ kind: 'error' }])], SID, Date.now(), none, false);
    expect(r.decision).toMatchObject({ analyze: true, replay: true });
  });

  it('sampling is deterministic per session and rule (shared vectors)', () => {
    const sampledOut = { ...rule('analyze'), id: 'r_8a0c', sample_rate: 0.083 };
    expect(setup([sampledOut]).r.decision.analyze).toBe(false);
    const sampledIn = { ...rule('analyze'), id: 'r_1f2e', sample_rate: 1 };
    expect(setup([sampledIn]).r.decision.analyze).toBe(true);
  });

  it('gates the flush on interaction and minimum duration; error rules bypass both', () => {
    vi.useFakeTimers({ now: Date.now() });
    const gated = rule('replay', [], { min_duration_ms: 3000, require_interaction: true });
    const { r } = setup([gated], Date.now());
    expect(r.decision.replay).toBe(false);
    r.interaction();
    expect(r.decision.replay).toBe(false);
    vi.advanceTimersByTime(3100);
    expect(r.decision.replay).toBe(true);

    const errRule = rule('replay', [{ kind: 'error' }], { min_duration_ms: 60_000, require_interaction: true });
    const e = setup([errRule], Date.now());
    e.r.input({ k: 'error', type: 'E', message: 'm', handling: 'unhandled' });
    expect(e.r.decision.replay).toBe(true);
  });

  it('a stored decision stays latched', () => {
    const { r } = setup([], Date.now(), { analyze: true, replay: false, rule_id: 'r_old' });
    expect(r.decision).toEqual({ analyze: true, replay: false, rule_id: 'r_old' });
  });

  it('names the rule that decided replay', () => {
    const a = { ...rule('analyze'), id: 'r_a' };
    const p = { ...rule('replay', [{ kind: 'event', name: 'go' }]), id: 'r_p' };
    const { r } = setup([a, p]);
    expect(r.decision.rule_id).toBe('r_a');
    r.input({ k: 'event', name: 'go' });
    expect(r.decision).toEqual({ analyze: true, replay: true, rule_id: 'r_p' });
    expect(r.replayCandidates()).toBe(true);
  });
});
