import { describe, it, expect } from 'vitest';
import {
  ContextManager,
  MAX_GLOBAL_ATTRIBUTES,
  MAX_ATTRIBUTE_KEY_LENGTH,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  MAX_GLOBAL_ATTRIBUTES_BYTES,
} from '../src/context';
import type { UserContext } from '../src/types';

function manager(): ContextManager {
  return new ContextManager({ applicationId: 'app-1', clientToken: 'ct_1' });
}

describe('global attributes', () => {
  it('sets, overwrites and removes', () => {
    const ctx = manager();
    ctx.setGlobalAttribute('plan', 'free');
    ctx.setGlobalAttribute('plan', 'pro');
    ctx.setGlobalAttribute('region', 'eu');
    expect(ctx.getGlobalAttributes()).toEqual({ plan: 'pro', region: 'eu' });

    ctx.removeGlobalAttribute('plan');
    ctx.removeGlobalAttribute('missing');
    expect(ctx.getGlobalAttributes()).toEqual({ region: 'eu' });
  });

  it('ignores blank, over-long or non-string keys and non-string values', () => {
    const ctx = manager();
    const loose = ctx as unknown as {
      setGlobalAttribute(k: unknown, v: unknown): void;
      removeGlobalAttribute(k: unknown): void;
    };
    ctx.setGlobalAttribute('', 'x');
    ctx.setGlobalAttribute('  ', 'x');
    ctx.setGlobalAttribute('k'.repeat(MAX_ATTRIBUTE_KEY_LENGTH + 1), 'x');
    loose.setGlobalAttribute(42, 'x');
    loose.setGlobalAttribute(undefined, undefined);
    loose.setGlobalAttribute('count', 3);
    loose.setGlobalAttribute('obj', { a: 1 });
    loose.removeGlobalAttribute(null);
    expect(ctx.getGlobalAttributes()).toEqual({});

    ctx.setGlobalAttribute('k'.repeat(MAX_ATTRIBUTE_KEY_LENGTH), 'ok');
    expect(Object.keys(ctx.getGlobalAttributes())).toHaveLength(1);
  });

  it('cuts values at the cap', () => {
    const ctx = manager();
    ctx.setGlobalAttribute('long', 'v'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH + 50));
    expect(ctx.getGlobalAttributes().long).toHaveLength(MAX_ATTRIBUTE_VALUE_LENGTH);
  });

  it('never cuts an emoji in half at the cap', () => {
    const ctx = manager();
    ctx.setGlobalAttribute('e', `${'v'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH - 1)}😀`);
    const value = ctx.getGlobalAttributes().e;
    expect(value).toBe('v'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH - 1));
    expect(JSON.stringify(value)).not.toMatch(/\\ud83d/i);
  });

  it('ignores new keys past the cap but still updates existing ones', () => {
    const ctx = manager();
    for (let i = 0; i < MAX_GLOBAL_ATTRIBUTES + 5; i++) {
      ctx.setGlobalAttribute(`k${i}`, 'v');
    }
    const attrs = ctx.getGlobalAttributes();
    expect(Object.keys(attrs)).toHaveLength(MAX_GLOBAL_ATTRIBUTES);
    expect(attrs[`k${MAX_GLOBAL_ATTRIBUTES}`]).toBeUndefined();

    ctx.setGlobalAttribute('k0', 'updated');
    expect(ctx.getGlobalAttributes().k0).toBe('updated');

    ctx.removeGlobalAttribute('k1');
    ctx.setGlobalAttribute('fresh', 'v');
    expect(ctx.getGlobalAttributes().fresh).toBe('v');
  });

  it('ignores a set that would take the total past the byte budget', () => {
    const ctx = manager();
    const big = 'v'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH);
    for (let i = 0; i < 10; i++) ctx.setGlobalAttribute(`k${i}`, big);
    const attrs = ctx.getGlobalAttributes();
    expect(Object.keys(attrs)).toHaveLength(3);
    expect(new TextEncoder().encode(JSON.stringify(attrs)).length)
      .toBeLessThanOrEqual(MAX_GLOBAL_ATTRIBUTES_BYTES);

    // Growing an existing key past the budget keeps its old value.
    ctx.setGlobalAttribute('k3', 'v'.repeat(500));
    ctx.setGlobalAttribute('k3', big);
    expect(ctx.getGlobalAttributes().k3).toBe('v'.repeat(500));
    ctx.removeGlobalAttribute('k1');
    ctx.setGlobalAttribute('k3', big);
    expect(ctx.getGlobalAttributes().k3).toBe(big);
  });

  it('counts multi-byte characters as bytes', () => {
    const ctx = manager();
    const wide = '€'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH);
    ctx.setGlobalAttribute('a', wide);
    ctx.setGlobalAttribute('b', wide);
    expect(Object.keys(ctx.getGlobalAttributes())).toEqual(['a']);
  });

  it('keeps a __proto__ key as a plain attribute', () => {
    const ctx = manager();
    ctx.setGlobalAttribute('__proto__', 'x');
    const attrs = ctx.getGlobalAttributes();
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(attrs))).toEqual(
      JSON.parse('{"__proto__":"x"}'),
    );
  });

  it('returns a copy', () => {
    const ctx = manager();
    ctx.setGlobalAttribute('plan', 'pro');
    ctx.getGlobalAttributes().plan = 'changed';
    expect(ctx.getGlobalAttributes()).toEqual({ plan: 'pro' });
  });
});

describe('setUser', () => {
  it('keeps string fields and turns numeric ones into strings', () => {
    const ctx = manager();
    ctx.setUser({ id: 42, email: 'user@example.com', name: '' } as unknown as UserContext);
    expect(ctx.getUser()).toEqual({ id: '42', email: 'user@example.com' });
  });

  it('drops other types and tolerates a missing user', () => {
    const ctx = manager();
    ctx.setUser({ id: { a: 1 }, email: null } as unknown as UserContext);
    expect(ctx.getUser()).toEqual({});
    ctx.setUser(undefined as unknown as UserContext);
    expect(ctx.getUser()).toEqual({});
  });
});
