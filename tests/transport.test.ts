import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TransportManager } from '../src/transport';
import { ReplayTransport } from '../src/replay/transport';
import { KEEPALIVE_MAX_BYTES } from '../src/send';

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

  it('sends immediately when an event is enqueued while the page is hidden', () => {
    // web-vitals finalizes CLS and INP on the way out, after the transport's own
    // visibilitychange listener has already flushed. Without this the last
    // measure of every session waits for an interval tick that never arrives.
    vi.stubGlobal('document', { visibilityState: 'hidden' });

    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      60000,
    );

    transport.enqueue({ type: 'vital', cls: 0.12, action_count: 3 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://rum.example.com/v1/measure');
    expect(options.keepalive).toBe(true);
    expect(JSON.parse(options.body)[0].cls).toBe(0.12);
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

  it('flushes on destroy with a keepalive fetch, never sendBeacon', () => {
    // A beacon cannot carry the Authorization header the ingest gateway
    // authenticates, and browsers send it with credentials, which the intake's
    // wildcard CORS answer refuses. The last batch has to go like every other.
    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beaconSpy });

    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      60000,
    );

    transport.enqueue({ type: 'view', url: '/page1' });
    transport.destroy();

    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(true);
  });

  it('authenticates by header and sends no cookies', () => {
    const transport = new TransportManager(
      'https://rum.example.com/v1/measure',
      'ct_test',
      60000,
    );

    transport.enqueue({ type: 'view', url: '/page1' });
    transport.destroy();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).not.toContain('token=');
    expect(options.headers.Authorization).toBe('Bearer ct_test');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.credentials).toBe('omit');
  });

  it('sends a batch over the keepalive cap without keepalive', () => {
    // Browsers refuse a keepalive request past 64 KiB outright. On a hidden
    // but still loaded page a plain request completes.
    const transport = new TransportManager(
      'https://rum.example.com/v1/errors',
      'ct_test',
      60000,
    );

    transport.enqueue({ type: 'error', stack: 'x'.repeat(KEEPALIVE_MAX_BYTES) });
    transport.destroy();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(false);
  });
});

describe('ReplayTransport', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a large segment without keepalive instead of dropping it', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const replay = new ReplayTransport('https://rum.example.com/v1/replay', 'ct_test');

    await replay.sendSegment('s1', {
      index: 0,
      events: [{ data: 'x'.repeat(KEEPALIVE_MAX_BYTES) }],
    });
    await replay.sendSegment('s1', { index: 1, events: [{ data: 'small' }] });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toContain('segment_index=0');
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(false);
    expect(fetchSpy.mock.calls[1][1].keepalive).toBe(true);
    expect(fetchSpy.mock.calls[1][1].credentials).toBe('omit');
    expect(fetchSpy.mock.calls[1][1].headers.Authorization).toBe('Bearer ct_test');
  });

  it('never rejects when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const replay = new ReplayTransport('https://rum.example.com/v1/replay', 'ct_test');

    await expect(
      replay.sendSegment('s1', { index: 0, events: [] }),
    ).resolves.toBeUndefined();
  });
});
