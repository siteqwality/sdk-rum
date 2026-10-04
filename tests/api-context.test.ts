import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import type { RumErrorEvent, RumDetailEvent } from '../src/types';
import {
  details,
  errors,
  init,
  resetSdk,
  serveConfig,
  settle,
  MATCH_ALL,
  type Registry,
} from './helpers/harness';

/**
 * addError/addAction context handling, through the real init with a
 * match-all rule (so custom actions ship detail) and recording transports.
 */

const h = vi.hoisted(() => ({
  transports: [] as Array<{ endpoint: string; events: unknown[] }>,
}));

vi.mock('../src/transport', () => ({
  TransportManager: class {
    events: unknown[] = [];
    constructor(public endpoint: string) {
      h.transports.push(this);
    }
    enqueue(event: unknown) {
      this.events.push(event);
    }
  },
}));
vi.mock('../src/collectors/vitals', () => ({ startVitalsCollector: vi.fn() }));

const registry = h.transports as Registry;

async function installInstance(ambient: Record<string, string>): Promise<void> {
  serveConfig([MATCH_ALL]);
  await init();
  await settle();
  for (const [k, v] of Object.entries(ambient)) {
    SiteQwalityRUM.setGlobalAttribute(k, v);
  }
}

function lastError(): RumErrorEvent {
  return errors(registry).at(-1)!;
}

function lastAction(): RumDetailEvent {
  return details(registry).filter((e) => e.type === 'action').at(-1)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSdk();
  h.transports.length = 0;
  history.replaceState({}, '', '/checkout?token=abc123&q=knee+surgery#step-2');
});

afterEach(() => {
  resetSdk();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('addError context', () => {
  it('attaches the context argument to custom_attributes', async () => {
    await installInstance({ plan: 'free' });
    SiteQwalityRUM.addError(new Error('boom'), { feature: 'checkout' });

    const event = lastError();
    expect(event.error_message).toBe('boom');
    expect(event.error_source).toBe('custom');
    expect(event.custom_attributes).toEqual({
      plan: 'free',
      feature: 'checkout',
    });
  });

  it('per-call context wins over ambient attributes on collision', async () => {
    await installInstance({ env: 'prod', plan: 'free' });
    SiteQwalityRUM.addError(new Error('boom'), { env: 'canary' });

    expect(lastError().custom_attributes).toEqual({
      env: 'canary',
      plan: 'free',
    });
  });

  it('without context, custom_attributes are the ambient attributes only', async () => {
    await installInstance({ plan: 'free' });
    SiteQwalityRUM.addError(new Error('boom'));

    expect(lastError().custom_attributes).toEqual({ plan: 'free' });
  });
});

describe('addAction context', () => {
  it('attaches the context argument to custom_attributes', async () => {
    await installInstance({ plan: 'free' });
    SiteQwalityRUM.addAction('buy-clicked', { sku: 'sq-123' });

    const event = lastAction();
    expect(event.action_type).toBe('custom');
    expect(event.action_target).toBe('buy-clicked');
    expect(event.custom_attributes).toEqual({ plan: 'free', sku: 'sq-123' });
  });

  it('per-call context wins over ambient attributes on collision', async () => {
    await installInstance({ env: 'prod' });
    SiteQwalityRUM.addAction('buy-clicked', { env: 'canary' });

    expect(lastAction().custom_attributes).toEqual({ env: 'canary' });
  });

  it('without context, custom_attributes are the ambient attributes only', async () => {
    await installInstance({ plan: 'free' });
    SiteQwalityRUM.addAction('buy-clicked');

    expect(lastAction().custom_attributes).toEqual({ plan: 'free' });
  });
});

describe('the url stamped on hand-reported events', () => {
  it('is minimised, not the raw location.href', async () => {
    await installInstance({});
    SiteQwalityRUM.addError(new Error('boom'));
    SiteQwalityRUM.addAction('buy-clicked');

    // jsdom serves the page from http://localhost:3000/.
    expect(window.location.href).toContain('token=abc123');
    expect(lastError().url).toBe('http://localhost:3000/checkout');
    expect(lastAction().url).toBe('http://localhost:3000/checkout');
  });
});

describe('the message and stack of a hand-reported error', () => {
  it('have their embedded URLs minimised, and keep the rest of the text', async () => {
    await installInstance({});

    const err = new Error(
      'Failed to fetch https://api.example.com/reset?token=tok_9f2',
    );
    err.stack =
      'Error: boom\n    at load (https://cdn.example.com/app.min.js?v=9f2:1:2345)';
    SiteQwalityRUM.addError(err);

    const event = lastError();
    expect(event.error_message).toBe(
      'Failed to fetch https://api.example.com/reset',
    );
    expect(event.error_stack).toBe(
      'Error: boom\n    at load (https://cdn.example.com/app.min.js:1:2345)',
    );
  });
});

describe('setGlobalAttribute / removeGlobalAttribute', () => {
  it('adds to custom_attributes on errors and actions; per-call context wins', async () => {
    await installInstance({});
    SiteQwalityRUM.setGlobalAttribute('plan', 'pro');
    SiteQwalityRUM.setGlobalAttribute('env', 'prod');

    SiteQwalityRUM.addError(new Error('boom'), { env: 'canary' });
    expect(lastError().custom_attributes).toEqual({ plan: 'pro', env: 'canary' });

    SiteQwalityRUM.addAction('buy-clicked');
    expect(lastAction().custom_attributes).toEqual({ plan: 'pro', env: 'prod' });
  });

  it('removes an attribute from later events', async () => {
    await installInstance({ plan: 'pro', region: 'eu' });
    SiteQwalityRUM.removeGlobalAttribute('plan');
    SiteQwalityRUM.addError(new Error('boom'));
    expect(lastError().custom_attributes).toEqual({ region: 'eu' });
  });

  it('never throws, before init or on bad input', async () => {
    const loose = SiteQwalityRUM as unknown as {
      setGlobalAttribute(k: unknown, v: unknown): void;
      removeGlobalAttribute(k: unknown): void;
    };
    expect(() => loose.setGlobalAttribute('plan', 'pro')).not.toThrow();
    expect(() => loose.removeGlobalAttribute('plan')).not.toThrow();

    await installInstance({});
    expect(() => loose.setGlobalAttribute(undefined, undefined)).not.toThrow();
    expect(() => loose.setGlobalAttribute({}, 1)).not.toThrow();
    expect(() => loose.removeGlobalAttribute(undefined)).not.toThrow();
    SiteQwalityRUM.addError(new Error('boom'));
    expect(lastError().custom_attributes).toEqual({});
  });
});

describe('user on hand-reported events', () => {
  it('stamps the user id and email', async () => {
    await installInstance({});
    SiteQwalityRUM.setUser({ id: 'user_123', email: 'user@example.com' });
    SiteQwalityRUM.addError(new Error('boom'));
    SiteQwalityRUM.addAction('buy-clicked');

    for (const event of [lastError(), lastAction()]) {
      expect(event.user_id).toBe('user_123');
      expect(event.user_email).toBe('user@example.com');
    }
  });

  it('omits both when unset', async () => {
    await installInstance({});
    SiteQwalityRUM.addError(new Error('boom'));
    expect(lastError()).not.toHaveProperty('user_id');
    expect(lastError()).not.toHaveProperty('user_email');
  });
});
