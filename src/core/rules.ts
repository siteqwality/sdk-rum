// Recording rules v2 (design 5.4, 6.2): deterministic per-session sampling, ALL conditions
// within a rule, ANY across rules, minimum duration and interaction gates on the flush.
import type { RecordingRule, RuleCondition } from '../types';
import type { Decision } from './session';
import { sampledIn } from './hash';
import { now, read } from './util';

export type RuleInput =
  | { k: 'url'; url: string; path: string }
  | { k: 'event'; name: string }
  | { k: 'error'; type: string; message: string; handling: string }
  | { k: 'network_error'; status: number; url: string }
  | { k: 'frustration'; type: string }
  | { k: 'vital'; metric: string; value: number }
  | { k: 'identified' }
  | { k: 'attribute'; key: string; value: string };

export interface StaticFacts {
  device: 'desktop' | 'mobile';
  release?: string;
  env?: string;
}

interface RuleState {
  rule: RecordingRule;
  held: boolean[];
  /** All conditions held at some point this session. */
  matched: boolean;
  bypass: boolean;
}

const HISTORY_MAX = 200;
const regexCache = new Map<string, RegExp | undefined>();

/** Compiled once; undefined for an expression that does not compile. */
function regex(source: string): RegExp | undefined {
  if (!regexCache.has(source)) regexCache.set(source, read(() => new RegExp(source)));
  return regexCache.get(source);
}

const statusClass = (s: number) => (s === 0 ? 'network' : s >= 500 ? '5xx' : s >= 400 ? '4xx' : '');

/** Whether one condition holds for one input; unknown kinds never hold (fail closed). */
export function holds(c: RuleCondition, i: RuleInput | null, f: StaticFacts): boolean {
  const v = typeof c.value === 'string' ? c.value : '';
  switch (c.kind) {
    case 'url': {
      if (i?.k !== 'url') return false;
      if (c.op === 'starts_with') return i.path.startsWith(v) || i.url.startsWith(v);
      if (c.op === 'regex') {
        const re = regex(v);
        return !!re && (re.test(i.path) || re.test(i.url));
      }
      return v !== '' && i.url.includes(v);
    }
    case 'event':
      return i?.k === 'event' && i.name === c.name;
    case 'error':
      return (
        i?.k === 'error' &&
        (!c.error_type || i.type === c.error_type) &&
        (!c.message_contains || i.message.includes(String(c.message_contains))) &&
        (c.unhandled_only !== true || i.handling.startsWith('unhandled'))
      );
    case 'network_error':
      return (
        i?.k === 'network_error' &&
        statusClass(i.status) === c.status_class &&
        (!c.url_contains || i.url.includes(String(c.url_contains)))
      );
    case 'frustration':
      return i?.k === 'frustration' && i.type === c.type;
    case 'vital':
      return i?.k === 'vital' && i.metric === c.metric && typeof c.gt === 'number' && i.value > c.gt;
    case 'identified':
      return i?.k === 'identified';
    case 'attribute':
      return i?.k === 'attribute' && i.key === c.key && i.value === c.value;
    case 'device':
      return f.device === c.class;
    case 'release':
      return !!f.release && (c.op === 'starts_with' ? f.release.startsWith(v) : f.release === v);
    case 'env':
      return !!f.env && f.env === v;
    default:
      return false;
  }
}

export type Rules = ReturnType<typeof createRules>;

/**
 * Evaluates rules on config arrival and synchronously on every input; no polling. Inputs are
 * kept for the session so rules that arrive later still see what already happened.
 */
export function createRules(facts: StaticFacts, onDecision: (d: Decision) => void) {
  let states: RuleState[] = [];
  let sessionId = '';
  let sessionStart = 0;
  let history: RuleInput[] = [];
  let interacted = false;
  let decision: Decision = { analyze: false, replay: false };
  let timer: ReturnType<typeof setTimeout> | null = null;

  function feed(i: RuleInput | null): void {
    for (const s of states) {
      if (s.matched) continue;
      s.rule.conditions.forEach((c, n) => {
        if (!s.held[n] && holds(c, i, facts)) s.held[n] = true;
      });
      s.matched = s.held.every(Boolean);
    }
  }

  /** Applies matched rules whose gates are open; schedules the duration gate. */
  function settle(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    const next: Decision = { ...decision };
    let wait = Infinity;
    for (const s of states) {
      if (!s.matched) continue;
      const left = sessionStart + s.rule.min_duration_ms - now();
      const open = s.bypass || ((!s.rule.require_interaction || interacted) && left <= 0);
      if (!open) {
        if (left > 0) wait = Math.min(wait, left);
        continue;
      }
      if (s.rule.capture === 'replay' && !next.replay) {
        next.replay = true;
        next.rule_id = s.rule.id;
      }
      if (!next.analyze) {
        next.analyze = true;
        if (!next.replay) next.rule_id = s.rule.id;
      }
    }
    if (wait < Infinity) timer = setTimeout(settle, wait + 5);
    if (next.analyze !== decision.analyze || next.replay !== decision.replay) {
      decision = next;
      onDecision(decision);
    }
  }

  function build(rules: RecordingRule[]): void {
    states = rules
      .filter((r) => sampledIn(`${sessionId}:${r.id}`, r.sample_rate))
      .map((rule) => ({
        rule,
        held: rule.conditions.map(() => false),
        matched: false,
        bypass: rule.conditions.some((c) => c.kind === 'error'),
      }));
    feed(null);
    for (const i of history) feed(i);
  }

  let current: RecordingRule[] = [];

  return {
    get decision(): Decision {
      return decision;
    },
    /** New rules, or a new session: `stored` is the decision already latched for it. */
    set(rules: RecordingRule[], sid: string, started: number, stored: Decision, fresh: boolean): void {
      if (fresh) {
        history = [];
        interacted = false;
      }
      current = rules;
      sessionId = sid;
      sessionStart = started;
      decision = { ...stored };
      build(current);
      settle();
    },
    input(i: RuleInput): void {
      if (history.length < HISTORY_MAX) history.push(i);
      feed(i);
      settle();
    },
    interaction(): void {
      if (interacted) return;
      interacted = true;
      settle();
    },
    /** Sampled-in rules that can record replay (2.1 starts the replay ring for these). */
    replayCandidates(): boolean {
      return states.some((s) => s.rule.capture === 'replay');
    },
  };
}
