import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serialize } from '../src/collectors/console';
import { SiteQwalityRUM } from '../src/sdk';
import { boot, clearStorage, config, flush, rule, stubNetwork } from './helpers/sdk';

const analyze = (extra: Record<string, unknown> = {}) => stubNetwork(config({ rules: [rule('analyze')], ...extra }));
const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
const originals = Object.fromEntries(levels.map((l) => [l, console[l]]));

beforeEach(() => {
  clearStorage();
  for (const l of levels) console[l] = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const l of levels) console[l] = originals[l];
});

describe('serialize', () => {
  it('handles awkward values without throwing', () => {
    const circular: Record<string, unknown> = { name: 'c' };
    circular.self = circular;
    let deep: Record<string, unknown> = { level: 0 };
    for (let i = 1; i < 6; i++) deep = { level: i, child: deep };
    expect(serialize(circular)).toBe('{name: "c", self: [circular]}');
    expect(serialize(deep)).toBe('{level: 5, child: {level: 4, child: {level: 3, child: [object]}}}');
    expect(serialize(new Map([['k', 1]]))).toBe('Map {"k" => 1}');
    expect(serialize(new Set([1, 2]))).toBe('Set {1, 2}');
    expect(serialize(Symbol('s'))).toBe('Symbol(s)');
    expect(serialize(10n)).toBe('10n');
    expect(serialize(function named() {})).toBe('[function named]');
    expect(serialize(Object.create(null))).toBe('{}');
    expect(serialize(document.body)).toBe('<body>');
    expect(serialize(new TypeError('bad'))).toBe('TypeError: bad');
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('no'); } });
    expect(serialize(hostile)).toBe('[unserializable]');
  });
});

describe('capture', () => {
  it('records the configured levels, calls the original once, and never records its own logs', async () => {
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    const net = await boot({}, analyze());
    console.warn('careful', { a: 1 });
    console.log('not configured');
    console.warn('[SiteQwality RUM] own');
    expect(warn).toHaveBeenCalledWith('careful', { a: 1 });
    expect(warn.mock.calls.filter((c) => c[0] === 'careful')).toHaveLength(1);
    await flush();
    expect(net.events('console').map((e) => [e.level, e.message, e.repeat])).toEqual([['warn', 'careful {a: 1}', 1]]);
  });

  it('folds identical consecutive lines and caps 50 per level per 10 s', async () => {
    const net = await boot({}, analyze());
    for (let i = 0; i < 100; i++) console.warn('same line');
    for (let i = 0; i < 80; i++) console.error('line', i);
    await flush();
    const rows = net.events('console');
    expect(rows.filter((r) => r.message === 'same line')).toEqual([expect.objectContaining({ repeat: 100 })]);
    expect(rows.filter((r) => r.level === 'error')).toHaveLength(50);
    expect(SiteQwalityRUM.getStatus()?.dropped.console_rate_limited).toBe(30);
  });

  it('scrubs, minimises and cuts entries to 2 KB, with the stack of an Error', async () => {
    const net = await boot({}, analyze());
    console.error('lookup failed for a@b.io at https://x.test/p?token=1', new Error('e'));
    console.warn('x'.repeat(5000));
    await flush();
    const [error, long] = net.events('console');
    expect(error.message).toBe('lookup failed for <email> at https://x.test/p Error: e');
    expect(error.stack).toContain('Error: e');
    expect(String(long.message).length).toBe(2048);
  });

  it('scrubs PII in the message line of an Error stack', async () => {
    const net = await boot({}, analyze());
    const e = new Error('no account for jane@acme.test');
    e.stack = 'Error: no account for jane@acme.test\n    at find (https://app.test/app.js:1:2)';
    console.error(e);
    await flush();
    const [row] = net.events('console');
    expect(row.stack).not.toContain('jane@acme.test');
    expect(row.stack).toContain('https://app.test/app.js:1:2');
  });

  it('turns console.error into an issue only when the app asks', async () => {
    const off = await boot();
    console.error('quiet');
    await flush();
    expect(off.events('error')).toEqual([]);
    const on = await boot({}, stubNetwork(config({ capture: { errors: { console_errors_as_issues: true } } })));
    console.error('payment failed', { code: 7 });
    console.error(new TypeError('bad card'));
    await flush();
    expect(on.events('error').map((e) => [e.handling, e.error_type, e.message])).toEqual([
      ['console', 'Error', 'payment failed {code: 7}'],
      ['console', 'TypeError', 'bad card'],
    ]);
  });

  it('console errors are breadcrumbs for every session, Analyze or not', async () => {
    const net = await boot();
    console.error('boom', 42);
    SiteQwalityRUM.addError(new Error('after'));
    await flush();
    expect(net.events('console')).toEqual([]);
    expect(net.events('error')[0].breadcrumbs).toEqual(expect.arrayContaining([expect.objectContaining({ k: 'console', msg: 'boom 42' })]));
  });
});
