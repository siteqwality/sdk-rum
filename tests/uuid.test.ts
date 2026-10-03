import { describe, it, expect, vi, afterEach } from 'vitest';
import { uuid } from '../src/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('uuid', () => {
  it('uses crypto.randomUUID where it exists', () => {
    expect(uuid()).toMatch(V4);
  });

  it('builds a v4 UUID from getRandomValues on plain http pages', () => {
    const getRandomValues = (a: Uint8Array) => a.fill(0xff);
    vi.stubGlobal('crypto', { getRandomValues });
    expect(uuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('still returns a v4 UUID with no crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    const ids = new Set(Array.from({ length: 50 }, () => uuid()));
    for (const id of ids) expect(id).toMatch(V4);
    expect(ids.size).toBe(50);
  });
});
