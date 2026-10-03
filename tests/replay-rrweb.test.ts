import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventType } from '@rrweb/types';
import {
  ReplayRecorder,
  CHECKOUT_EVERY_MS,
  type ReplaySegment,
} from '../src/replay/recorder';
import { createUrlSanitizer } from '../src/privacy/url';

// Runs the real rrweb recorder, not a stand-in.
describe('ReplayRecorder with rrweb', () => {
  let recorder: ReplayRecorder;
  let segments: ReplaySegment[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    sessionStorage.clear();
    document.body.innerHTML = '<main><p id="p">hello</p></main>';
    recorder = new ReplayRecorder();
    segments = [];
  });

  afterEach(() => {
    recorder.stop();
    vi.useRealTimers();
  });

  const types = (s: ReplaySegment) => s.events.map((e) => (e as { type: number }).type);

  async function mutate(text: string) {
    document.getElementById('p')!.textContent = text;
    await Promise.resolve();
    await Promise.resolve();
  }

  it('opens a new segment with a full snapshot at each checkout', async () => {
    await recorder.start(
      'session-1',
      (s) => segments.push(s),
      { maskInputs: true, maskText: false },
      createUrlSanitizer(),
    );
    await mutate('one');
    vi.setSystemTime(Date.now() + CHECKOUT_EVERY_MS + 1);
    await mutate('two');
    await mutate('three');
    recorder.stop();

    expect(segments.map((s) => s.index)).toEqual([0, 1]);
    expect(types(segments[0]).slice(0, 2)).toEqual([EventType.Meta, EventType.FullSnapshot]);
    expect(types(segments[1]).slice(0, 2)).toEqual([EventType.Meta, EventType.FullSnapshot]);
    expect(types(segments[1]).slice(2)).toEqual([EventType.IncrementalSnapshot]);
  });

  it('continues numbering when the page is reloaded', async () => {
    for (let load = 0; load < 3; load++) {
      recorder = new ReplayRecorder();
      await recorder.start(
        'session-1',
        (s) => segments.push(s),
        { maskInputs: true, maskText: false },
        createUrlSanitizer(),
      );
      await mutate(`load ${load}`);
      recorder.stop();
    }
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
    for (const s of segments) expect(types(s)[1]).toBe(EventType.FullSnapshot);
  });

  it('drops the document of a blocked iframe and keeps an open one', async () => {
    document.body.innerHTML =
      '<p id="p">hello</p><iframe class="rr-block"></iframe><iframe id="open"></iframe>';
    await recorder.start(
      'session-1',
      (s) => segments.push(s),
      { maskInputs: true, maskText: false },
      createUrlSanitizer(),
    );
    vi.advanceTimersByTime(10_000);
    await mutate('after');
    recorder.stop();

    const attached = segments
      .flatMap((s) => s.events)
      .filter((e) => (e as { data?: { isAttachIframe?: boolean } }).data?.isAttachIframe);
    expect(attached).toHaveLength(1);
  });
});
