import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplayRecorder } from '../src/replay/recorder';
import { createUrlSanitizer } from '../src/privacy/url';

// rrweb loading is held open by hand, to order a start against a stop.
const h = vi.hoisted(() => ({
  loads: [] as Array<{ url: string | undefined; resolve: (record: unknown) => void }>,
  recorded: [] as string[],
}));

vi.mock('../src/replay/load-record', () => ({
  loadRecord: (url?: string) => new Promise((resolve) => h.loads.push({ url, resolve })),
}));

function fakeRecord(label: string) {
  return Object.assign(
    () => {
      h.recorded.push(label);
      return () => {};
    },
    { mirror: { getNode: () => null } },
  );
}

const privacy = { maskInputs: true, maskText: false };

beforeEach(() => {
  h.loads.length = 0;
  h.recorded.length = 0;
});

describe('ReplayRecorder start and stop while loading', () => {
  it('records only the start that was not overtaken', async () => {
    const recorder = new ReplayRecorder();
    const first = recorder.start('old-session', () => {}, privacy, createUrlSanitizer());
    recorder.stop();
    const second = recorder.start('new-session', () => {}, privacy, createUrlSanitizer());
    h.loads[1].resolve(fakeRecord('second'));
    h.loads[0].resolve(fakeRecord('first'));
    await Promise.all([first, second]);
    expect(h.recorded).toEqual(['second']);
    recorder.stop();
  });

  it('passes recorderUrl to the loader', async () => {
    const recorder = new ReplayRecorder();
    const started = recorder.start('s', () => {}, privacy, createUrlSanitizer(), 'https://static.example/rec.js');
    expect(h.loads[0].url).toBe('https://static.example/rec.js');
    h.loads[0].resolve(fakeRecord('one'));
    await started;
    expect(h.recorded).toEqual(['one']);
    recorder.stop();
  });
});
