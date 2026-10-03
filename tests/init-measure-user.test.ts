import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import { startViewCollector } from '../src/collectors/views';
import { startVitalsCollector } from '../src/collectors/vitals';
import type { RumMeasureEvent, ViewEvent } from '../src/types';

// Collectors are stubbed; their callbacks are driven by hand.
vi.mock('../src/collectors/resources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/collectors/resources')>()),
  startResourceCollector: vi.fn(),
}));
vi.mock('../src/collectors/views', () => ({ startViewCollector: vi.fn() }));
vi.mock('../src/collectors/vitals', () => ({ startVitalsCollector: vi.fn() }));
vi.mock('../src/collectors/errors', () => ({ startErrorCollector: vi.fn() }));
vi.mock('../src/collectors/actions', () => ({ startActionCollector: vi.fn() }));
vi.mock('../src/collectors/long-tasks', () => ({ startLongTaskCollector: vi.fn() }));

let measureEnqueue: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  vi.mocked(startViewCollector).mockClear();
  vi.mocked(startVitalsCollector).mockClear();
  await SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1' });
  const inst = (SiteQwalityRUM as unknown as {
    instance: { measureTransport: { enqueue: (e: unknown) => void } };
  }).instance;
  measureEnqueue = vi.fn();
  inst.measureTransport.enqueue = measureEnqueue;
});

afterEach(() => {
  (SiteQwalityRUM as unknown as { instance: unknown }).instance = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function emitView(): RumMeasureEvent {
  const onView = vi.mocked(startViewCollector).mock.calls[0][0];
  const view: ViewEvent = {
    view_id: crypto.randomUUID(),
    url: 'http://localhost:3000/',
    timestamp: Date.now(),
  };
  onView(view);
  return measureEnqueue.mock.calls.at(-1)![0] as RumMeasureEvent;
}

function emitVital(): RumMeasureEvent {
  const onVital = vi.mocked(startVitalsCollector).mock.calls[0][0];
  onVital('lcp_ms', 1200);
  return measureEnqueue.mock.calls.at(-1)![0] as RumMeasureEvent;
}

describe('user on measures', () => {
  it('view and vital measures carry the current user', () => {
    SiteQwalityRUM.setUser({ id: 'user_123', email: 'user@example.com' });

    for (const measure of [emitView(), emitVital()]) {
      expect(measure.user_id).toBe('user_123');
      expect(measure.user_email).toBe('user@example.com');
    }
  });

  it('omits both fields when no user is set', () => {
    for (const measure of [emitView(), emitVital()]) {
      const body = JSON.parse(JSON.stringify(measure));
      expect(body).not.toHaveProperty('user_id');
      expect(body).not.toHaveProperty('user_email');
    }
  });

  it('omits an unset email and sends a numeric id as a string', () => {
    SiteQwalityRUM.setUser({ id: 7 } as unknown as { id: string });
    const measure = emitView();
    expect(measure.user_id).toBe('7');
    expect(measure).not.toHaveProperty('user_email');
  });

  it('follows a later setUser', () => {
    SiteQwalityRUM.setUser({ id: 'a' });
    expect(emitView().user_id).toBe('a');
    SiteQwalityRUM.setUser({});
    expect(emitVital()).not.toHaveProperty('user_id');
  });
});
