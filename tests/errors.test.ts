import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  noiseRule,
  fromValue,
  fromErrorEvent,
  fromRejection,
  createErrorPipeline,
  createMatcher,
  MAX_ERRORS_PER_PAGE,
  FOLD_MS,
  type RawError,
} from '../src/collectors/errors';
import { normalizeConfig } from '../src/core/config';
import { createUrlSanitizer, createTextUrlSanitizer } from '../src/core/url';
import { createScrubber } from '../src/core/sanitize';
import type { Hub } from '../src/hub';
import type { SqEvent } from '../src/types';

interface Case {
  name: string;
  message: string;
  stack: string;
  filename: string;
  ignore: boolean;
}
const load = (f: string): Case[] => JSON.parse(readFileSync(join(__dirname, 'fixtures', f), 'utf8'));

describe('noise rules', () => {
  it.each(load('error-noise-cases.json').map((c) => [c.name, c]))('shared case: %s', (_, c) => {
    expect(noiseRule(c.message, c.stack, c.filename) !== null).toBe(c.ignore);
  });
  it.each(load('error-noise-extra-cases.json').map((c) => [c.name, c]))('extra case: %s', (_, c) => {
    expect(noiseRule(c.message, c.stack, c.filename) !== null).toBe(c.ignore);
  });
  it.each(load('error-noise-v2-cases.json').map((c) => [c.name, c]))('N4 to N9: %s', (_, c) => {
    expect(noiseRule(c.message, c.stack, c.filename) !== null).toBe(c.ignore);
  });
  it('names the rule', () => {
    expect(noiseRule('ResizeObserver loop limit exceeded', '')).toBe('n1');
    expect(noiseRule('Script error.', '')).toBe('n2');
    expect(noiseRule('x', 'at f (chrome-extension://abc/x.js:1:1)')).toBe('n3');
    expect(noiseRule("Can't find variable: gmo", '')).toBe('n6');
  });
});

describe('raw errors', () => {
  it('reads an Error: name, message, stack and up to 3 causes', () => {
    const e = new Error('a', { cause: new TypeError('b', { cause: 'c' }) });
    const raw = fromValue(e);
    expect(raw).toMatchObject({ type: 'Error', message: 'a', handling: 'handled' });
    expect(raw.cause).toEqual([
      { type: 'TypeError', message: 'b', stack: expect.any(String) },
      { type: 'Error', message: 'c', stack: '' },
    ]);
  });

  it('serialises other values, cut to 1 KB, without throwing on hostile ones', () => {
    expect(fromValue({ a: 1 }).message).toBe('{"a":1}');
    expect(fromValue('x'.repeat(2000)).message.length).toBe(2000);
    expect(fromValue({ big: 'y'.repeat(2000) }).message.length).toBe(1024);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(fromValue(circular).message).toBe('[object Object]');
    expect(fromValue(Object.create(null)).message).toBe('{}');
    expect(fromValue(undefined).message).toBe('undefined');
  });

  it('splits the type from an onerror message without an Error object', () => {
    expect(fromErrorEvent(new ErrorEvent('error', { message: 'Uncaught TypeError: x is null' }))).toMatchObject({ type: 'TypeError', message: 'x is null', handling: 'unhandled' });
    expect(fromErrorEvent(new ErrorEvent('error', { message: 'Uncaught fx:throw-string', error: 'fx:throw-string' }))).toMatchObject({ type: 'Error', message: 'fx:throw-string' });
    expect(fromErrorEvent({})).toBeNull();
  });

  it('rejections: Errors keep their type, other reasons are UnhandledRejection', () => {
    const ev = (reason: unknown) => Object.assign(new Event('unhandledrejection'), { reason });
    expect(fromRejection(ev(new RangeError('r')))).toMatchObject({ type: 'RangeError', handling: 'unhandledrejection' });
    expect(fromRejection(ev('plain'))).toMatchObject({ type: 'UnhandledRejection', message: 'plain' });
    expect(fromRejection(ev({ code: 7 }))).toMatchObject({ type: 'UnhandledRejection', message: '{"code":7}' });
  });
});

describe('createMatcher', () => {
  it('substrings and RegExps, global ones included', () => {
    const m = createMatcher(['chunk', /^Load(ing)? failed/g, 3]);
    expect(m('ChunkLoadError chunk 7')).toBe(true);
    expect(m('Loading failed')).toBe(true);
    expect(m('Loading failed')).toBe(true);
    expect(m('other')).toBe(false);
  });
});

describe('the pipeline', () => {
  let sent: SqEvent[];
  let counts: Record<string, number>;
  let cfg = normalizeConfig(null, 'a');
  let hub: Hub;
  let crumbs: unknown[];
  let after: Array<{ raw: RawError; e: SqEvent }>;

  function make(opts: Record<string, unknown> = {}) {
    sent = [];
    counts = {};
    crumbs = [];
    after = [];
    const url = createUrlSanitizer();
    hub = {
      opts: { applicationId: 'a', clientToken: 't', ...opts },
      cfg: () => cfg,
      url,
      text: createTextUrlSanitizer(url),
      scrub: createScrubber(['email', 'card', 'digits9']),
      emit: (e) => (sent.push(e), true),
      input: () => {},
      crumb: () => {},
      count: (n, k = 1) => (counts[n] = (counts[n] ?? 0) + k),
      isOwn: () => false,
      pageUrl: () => '',
      viewId: () => 'v1',
    };
    return createErrorPipeline(hub, { crumbs: () => crumbs, orphan: () => false, sent: (raw, e) => after.push({ raw, e }) });
  }

  beforeEach(() => {
    cfg = normalizeConfig(null, 'a');
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const err = (message: string, stack = `Error: ${message}\n    at save (https://app.test/assets/app-BKjK5o9P.js:4:24)`): RawError => ({ type: 'Error', message, stack, handling: 'unhandled', raw: message });

  it('builds the 6.3 event with an error_key that ignores digits and bundle hashes', () => {
    const p = make();
    p.report(err('order 1 failed'), 5);
    p.report({ ...err('order 2 failed', 'Error: order 2 failed\n    at save (https://app.test/assets/app-Dz9_q1Lm.js:4:24)'), message: 'order 2 failed' }, 6);
    expect(sent[0]).toMatchObject({ k: 'error', t: 5, view_id: 'v1', error_type: 'Error', message: 'order 1 failed', handling: 'unhandled', repeat: 1 });
    expect(sent[1].error_key).toBe(sent[0].error_key);
    expect(after).toHaveLength(2);
  });

  it('applies ignoreErrors, denyUrls and the dashboard lists, counting each', () => {
    cfg.capture.errors.ignore = ['third-party'];
    cfg.capture.errors.deny_urls = ['widgets.example'];
    const p = make({ ignoreErrors: [/ignored/], denyUrls: ['cdn.ads.example'] });
    p.report(err('ignored by code'));
    p.report(err('a third-party failure'));
    p.report(err('denied', 'Error: denied\n    at f (https://cdn.ads.example/x.js:1:1)'));
    p.report(err('denied 2', 'Error: d\n    at f (https://widgets.example/w.js:1:1)'));
    expect(sent).toEqual([]);
    expect(counts).toEqual({ ignored_error: 2, denied_error: 2 });
  });

  it('drops suppressed error keys', () => {
    const p = make();
    p.report(err('boom'));
    cfg.capture.errors.suppressed_keys = [sent[0].error_key as number];
    p.report(err('boom'), 99_999);
    expect(sent).toHaveLength(1);
    expect(counts.suppressed_error).toBe(1);
  });

  it('folds identical errors within 5 s into one more event with their count', () => {
    const p = make();
    for (let i = 0; i < 30; i++) p.report(err('burst'), 100 + i);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(FOLD_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ repeat: 29, t: 129 });
    expect(sent[1].id).not.toBe(sent[0].id);
  });

  it('limits bursts per error_key: 10, then 1 per 10 s', () => {
    const p = make();
    for (let i = 0; i < 15; i++) p.report(err(`id ${i}`, `Error: id\n    at f${i} (https://app.test/a.js:1:${i})`), Date.now());
    expect(sent).toHaveLength(10);
    expect(counts.rate_limited_error).toBe(5);
  });

  it('sends at most 500 per page', () => {
    const p = make();
    for (let i = 0; i < MAX_ERRORS_PER_PAGE + 20; i++) p.report({ ...err(`e${i}`), type: `T${i}` }, i * 20_000);
    expect(sent.length).toBe(MAX_ERRORS_PER_PAGE);
  });

  it('scrubs messages and stack text but keeps frame paths', () => {
    const p = make();
    p.report(err('no account for jane@x.io 123456789', 'Error: no account for jane@x.io\n    at save (https://app.test/u/123456789/app.js?token=x:4:24)'));
    expect(sent[0].message).toBe('no account for <email> <digits>');
    expect(sent[0].stack).toBe('Error: no account for <email>\n    at save (https://app.test/u/123456789/app.js:4:24)');
  });

  it('attaches the last breadcrumbs within 8 KB, context and a custom fingerprint', () => {
    const p = make();
    crumbs = Array.from({ length: 40 }, (_, i) => ({ t: i, k: 'click', msg: 'x'.repeat(250) }));
    p.report(err('boom'), 1, { a: 'b', n: 1, 'sq.fingerprint': 'fp-1' });
    const e = sent[0] as SqEvent & { breadcrumbs: unknown[] };
    expect(e.breadcrumbs.length).toBeLessThanOrEqual(30);
    expect(JSON.stringify(e.breadcrumbs).length).toBeLessThanOrEqual(8192);
    expect(e.context).toEqual({ a: 'b' });
    expect(e.fingerprint).toBe('fp-1');
  });

  it('maps Debug IDs registered on globalThis to the stack files', () => {
    (globalThis as { _sqDebugIds?: Record<string, string> })._sqDebugIds = {
      'Error\n    at https://app.test/assets/app-BKjK5o9P.js:1:1': '1f2e3d4c-0000-4000-8000-000000000001',
    };
    try {
      const p = make();
      p.report(err('boom'));
      expect(sent[0].debug_ids).toEqual({ 'https://app.test/assets/app-BKjK5o9P.js': '1f2e3d4c-0000-4000-8000-000000000001' });
    } finally {
      delete (globalThis as { _sqDebugIds?: unknown })._sqDebugIds;
    }
  });

  it('an error raised while one is being sent is dropped (no recursion)', () => {
    const p = make();
    hub.emit = (e) => {
      sent.push(e);
      p.report(err('inside'));
      return true;
    };
    p.report(err('outer'));
    expect(sent.map((e) => e.message)).toEqual(['outer']);
  });

  it('a hidden tab whose session expired keeps nothing', () => {
    make();
    const url = createUrlSanitizer();
    const local: SqEvent[] = [];
    const p = createErrorPipeline({ ...hub, url, text: createTextUrlSanitizer(url), emit: (e) => (local.push(e), true) }, { crumbs: () => [], orphan: () => true, sent: () => {} });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    p.report(err('late'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    expect(local).toEqual([]);
  });
});
