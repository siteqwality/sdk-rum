import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import { ContextManager } from '../src/context';
import { SessionManager } from '../src/session';
import type { RumErrorEvent, RumDetailEvent } from '../src/types';

/**
 * addError/addAction context handling. A minimal instance is assembled by
 * hand (transports stubbed) instead of running full init, which needs
 * browser APIs (PerformanceObserver, rrweb) jsdom does not provide.
 */

const errorEnqueue = vi.fn();
const eventEnqueue = vi.fn();

function installInstance(ambient: Record<string, string>): void {
  const context = new ContextManager({
    applicationId: 'app-1',
    clientToken: 'token-1',
  });
  for (const [k, v] of Object.entries(ambient)) {
    context.setGlobalAttribute(k, v);
  }

  const inst = Object.create(SiteQwalityRUM.prototype);
  Object.assign(inst, {
    session: new SessionManager(),
    context,
    options: { applicationId: 'app-1', clientToken: 'token-1' },
    currentViewId: 'view-1',
    sessionState: {
      hasError: false,
      errorCount: 0,
      pageCount: 0,
      actionCount: 0,
    },
    detailActive: true, // actions only ship detail when sampling is active
    errorTransport: { enqueue: errorEnqueue },
    eventTransport: { enqueue: eventEnqueue },
  });
  (SiteQwalityRUM as unknown as { instance: unknown }).instance = inst;
}

function lastError(): RumErrorEvent {
  return errorEnqueue.mock.calls.at(-1)![0] as RumErrorEvent;
}

function lastAction(): RumDetailEvent {
  return eventEnqueue.mock.calls.at(-1)![0] as RumDetailEvent;
}

beforeEach(() => {
  errorEnqueue.mockClear();
  eventEnqueue.mockClear();
});

afterEach(() => {
  (SiteQwalityRUM as unknown as { instance: unknown }).instance = null;
});

describe('addError context', () => {
  it('attaches the context argument to custom_attributes', () => {
    installInstance({ plan: 'free' });
    SiteQwalityRUM.addError(new Error('boom'), { feature: 'checkout' });

    const event = lastError();
    expect(event.error_message).toBe('boom');
    expect(event.error_source).toBe('custom');
    expect(event.custom_attributes).toEqual({
      plan: 'free',
      feature: 'checkout',
    });
  });

  it('per-call context wins over ambient attributes on collision', () => {
    installInstance({ env: 'prod', plan: 'free' });
    SiteQwalityRUM.addError(new Error('boom'), { env: 'canary' });

    expect(lastError().custom_attributes).toEqual({
      env: 'canary',
      plan: 'free',
    });
  });

  it('without context, custom_attributes are the ambient attributes only', () => {
    installInstance({ plan: 'free' });
    SiteQwalityRUM.addError(new Error('boom'));

    expect(lastError().custom_attributes).toEqual({ plan: 'free' });
  });
});

describe('addAction context', () => {
  it('attaches the context argument to custom_attributes', () => {
    installInstance({ plan: 'free' });
    SiteQwalityRUM.addAction('buy-clicked', { sku: 'sq-123' });

    const event = lastAction();
    expect(event.action_type).toBe('custom');
    expect(event.action_target).toBe('buy-clicked');
    expect(event.custom_attributes).toEqual({ plan: 'free', sku: 'sq-123' });
  });

  it('per-call context wins over ambient attributes on collision', () => {
    installInstance({ env: 'prod' });
    SiteQwalityRUM.addAction('buy-clicked', { env: 'canary' });

    expect(lastAction().custom_attributes).toEqual({ env: 'canary' });
  });

  it('without context, custom_attributes are the ambient attributes only', () => {
    installInstance({ plan: 'free' });
    SiteQwalityRUM.addAction('buy-clicked');

    expect(lastAction().custom_attributes).toEqual({ plan: 'free' });
  });
});
