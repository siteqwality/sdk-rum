import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TransportManager } from '../src/transport';

describe('TransportManager', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('batches events and flushes on interval', () => {
    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      5000,
    );

    transport.enqueue({ type: 'view', url: '/page1' });
    transport.enqueue({ type: 'view', url: '/page2' });

    // Not flushed yet
    expect(fetchSpy).not.toHaveBeenCalled();

    // Advance past the flush interval
    vi.advanceTimersByTime(5000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://rum.example.com/v1/measure');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body).toHaveLength(2);
    expect(body[0].url).toBe('/page1');
    expect(body[1].url).toBe('/page2');

    transport.destroy();
  });

  it('flushes immediately when queue reaches 50 events', () => {
    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      60000,
    );

    for (let i = 0; i < 50; i++) {
      transport.enqueue({ type: 'view', url: `/page${i}` });
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toHaveLength(50);

    transport.destroy();
  });

  it('does not flush when queue is empty', () => {
    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      5000,
    );

    vi.advanceTimersByTime(5000);
    expect(fetchSpy).not.toHaveBeenCalled();

    transport.destroy();
  });

  it('beacons immediately when an event is enqueued while the page is hidden', () => {
    // web-vitals finalizes CLS and INP on the way out, after the transport's own
    // visibilitychange listener has already flushed. Without this the last
    // measure of every session waits for an interval tick that never arrives.
    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beaconSpy });
    vi.stubGlobal('document', { visibilityState: 'hidden' });

    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      60000,
    );

    transport.enqueue({ type: 'vital', cls: 0.12, action_count: 3 });

    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(beaconSpy.mock.calls[0][0]).toContain('token=ct_test');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not flush early while the page is still visible', () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });

    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      60000,
    );

    transport.enqueue({ type: 'view', url: '/page1' });

    expect(fetchSpy).not.toHaveBeenCalled();

    transport.destroy();
  });

  it('uses sendBeacon on destroy/unload', () => {
    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beaconSpy });

    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      60000,
    );

    transport.enqueue({ type: 'view', url: '/page1' });
    transport.destroy();

    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(beaconSpy.mock.calls[0][0]).toContain('token=ct_test');
  });
});
