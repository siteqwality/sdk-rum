// Neither CompressionStream nor the fflate fallback (blocked by CSP, say): segments go as JSON
// within the intake's wire cap.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReplayTransport, MAX_WIRE_BYTES } from '../src/replay/transport';
import { streamFor } from '../src/replay/stream';
import { send } from '../src/core/send';
import type { Segment } from '../src/replay/segmenter';

vi.mock('../src/replay/gzip-load', () => ({ loadGzip: () => Promise.reject(new Error('blocked')) }));

let fetchSpy: ReturnType<typeof vi.fn>;
const seg = (fs: boolean, pad: number): Segment => {
  const json = [JSON.stringify({ type: fs ? 2 : 3, timestamp: 1, pad: 'x'.repeat(pad) })];
  return { json, bytes: json[0].length, ft: 1, lt: 1, fs, css: [] };
};
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.stubGlobal('CompressionStream', undefined);
  fetchSpy = vi.fn(() => Promise.resolve({ ok: true, status: 202 }));
});
afterEach(() => vi.unstubAllGlobals());

describe('ReplayTransport without compression', () => {
  it('sends a segment as application/json', async () => {
    const t = new ReplayTransport('https://r.test', 'ct', fetchSpy as unknown as typeof fetch, send);
    void t.push(streamFor('s-nogzip-1', 'w', 'p'), seg(true, 100));
    await until(() => fetchSpy.mock.calls.length > 0);
    expect(fetchSpy.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
    expect(typeof fetchSpy.mock.calls[0][1].body).toBe('string');
  });

  it('never sends a body over the wire cap; a snapshot that large stops replay', async () => {
    const tooLarge = vi.fn();
    const count = vi.fn();
    const t = new ReplayTransport('https://r.test', 'ct', fetchSpy as unknown as typeof fetch, send, { tooLarge, count });
    const st = streamFor('s-nogzip-2', 'w', 'p');
    void t.push(st, seg(false, MAX_WIRE_BYTES));
    void t.push(st, seg(true, MAX_WIRE_BYTES));
    await until(() => tooLarge.mock.calls.length > 0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith('replay_segments_dropped');
    expect(tooLarge).toHaveBeenCalledTimes(1);
  });
});
