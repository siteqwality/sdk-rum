import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { EventType } from '@rrweb/types';
import {
  ReplayRecorder,
  CHECKOUT_EVERY_MS,
  type ReplaySegment,
} from '../src/replay/recorder';
import { ReplayTransport, MAX_SEGMENT_BYTES } from '../src/replay/transport';
import { createUrlSanitizer } from '../src/privacy/url';

// Runs the real rrweb recorder, not a stand-in.
describe('ReplayRecorder with rrweb', () => {
  let recorder: ReplayRecorder;
  let segments: ReplaySegment[];

  // One fake clock for the file: rrweb keeps the Date.now it first imports with.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '<main><p id="p">hello</p></main>';
    recorder = new ReplayRecorder();
    segments = [];
  });

  afterEach(() => {
    recorder.stop();
    vi.restoreAllMocks();
  });

  const types = (s: ReplaySegment) => s.json.map((j) => JSON.parse(j).type as number);

  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  async function mutate(text: string) {
    document.getElementById('p')!.textContent = text;
    await settle();
  }

  function start(onSegment = (s: ReplaySegment) => void segments.push(s)) {
    return recorder.start(
      'session-1',
      onSegment,
      { maskInputs: true, maskText: false },
      createUrlSanitizer(),
    );
  }

  it('opens a new segment with a full snapshot at each checkout', async () => {
    await start();
    await mutate('one');
    vi.setSystemTime(Date.now() + CHECKOUT_EVERY_MS + 1);
    await mutate('two');
    await mutate('three');
    recorder.stop();

    expect(segments.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(segments.map(types)).toEqual([
      [EventType.Meta, EventType.FullSnapshot],
      [EventType.IncrementalSnapshot, EventType.IncrementalSnapshot],
      [EventType.Meta, EventType.FullSnapshot],
      [EventType.IncrementalSnapshot],
    ]);
  });

  it('continues numbering when the page is reloaded', async () => {
    for (let load = 0; load < 3; load++) {
      recorder = new ReplayRecorder();
      await start();
      await mutate(`load ${load}`);
      recorder.stop();
    }
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const s of segments.filter((_, i) => i % 2 === 0)) {
      expect(types(s)).toEqual([EventType.Meta, EventType.FullSnapshot]);
    }
  });

  it('drops the document of a blocked iframe and keeps an open one', async () => {
    document.body.innerHTML =
      '<p id="p">hello</p><iframe class="rr-block"></iframe><iframe id="open"></iframe>';
    await start();
    vi.advanceTimersByTime(10_000);
    await mutate('after');
    recorder.stop();

    const attached = segments
      .flatMap((s) => s.json)
      .filter((j) => j.includes('"isAttachIframe":true'));
    expect(attached).toHaveLength(1);
  });

  it('sends no later segment of a page whose snapshot is too large', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: Array<{ segment_index: number; events: Array<{ type: number }> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, status: 202 };
      }),
    );
    document.body.innerHTML = `<p id="p">hello</p><div>${'x'.repeat(MAX_SEGMENT_BYTES)}</div>`;
    const transport = new ReplayTransport('https://replay.example/v1/segments', 'ct');

    await start((s) => void transport.sendSegment('session-1', s));
    await settle();
    await mutate('changed');
    vi.advanceTimersByTime(CHECKOUT_EVERY_MS * 2);
    await settle();
    vi.unstubAllGlobals();

    expect(sent.map((b) => b.events.map((e) => e.type))).toEqual([[EventType.Meta]]);
  });
});
