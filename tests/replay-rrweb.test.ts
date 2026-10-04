// The recorder with the real rrweb in jsdom: checkouts, CSS references, frames, the size gate,
// hidden inputs and privacy canaries through the ring.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { EventType } from '@rrweb/types';
import { ReplayRecorder, CHECKOUT_EVERY_MS, SNAPSHOT_MAX_BYTES, replayPrivacy } from '../src/replay/recorder';
import type { Segment } from '../src/replay/segmenter';
import { CssStore } from '../src/replay/css';
import type { Stream } from '../src/replay/stream';
import { createUrlSanitizer, createTextUrlSanitizer } from '../src/core/url';
import { createScrubber } from '../src/core/sanitize';
import { normalizeConfig } from '../src/core/config';

// Imported once the fake clock is installed: rrweb keeps the Date.now it first imports with.
let record: typeof import('@rrweb/record').record;
const url = createUrlSanitizer();

describe('ReplayRecorder with rrweb', () => {
  let recorder: ReplayRecorder;
  let segments: Segment[];
  let stream: Stream;
  let states: Array<string | undefined>;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    ({ record } = await import('@rrweb/record'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '<main><p id="p">hello</p></main>';
    recorder = new ReplayRecorder();
    segments = [];
    states = [];
    stream = { s: 'sid', w: 'win', p: 'pl', q: 0, css: new CssStore() };
  });

  afterEach(() => {
    recorder.stop(true);
    vi.restoreAllMocks();
  });

  const types = (s: Segment) => s.json.map((j) => JSON.parse(j).type as number);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  async function mutate(text: string) {
    document.getElementById('p')!.textContent = text;
    await settle();
  }

  function start(o: { buffer?: boolean; level?: 'strict' | 'balanced' | 'relaxed'; maskInputs?: boolean; maskText?: boolean } = {}) {
    const privacy = o.level
      ? replayPrivacy(normalizeConfig({ privacy: { level: o.level } }, 'a').privacy, createScrubber(['email', 'card', 'digits9'], true))
      : { maskInputs: o.maskInputs ?? true, maskAllText: o.maskText ?? false, blockSelector: '' };
    recorder.start({
      record,
      privacy,
      url,
      text: createTextUrlSanitizer(url),
      now: () => Date.now(),
      stream: () => stream,
      buffer: o.buffer,
      onSegment: (s) => void segments.push(s),
      onStatus: (state, why) => states.push(why ?? state),
    });
  }

  it('opens a segment with a full snapshot at each checkout, where a segment closes', async () => {
    start();
    await mutate('one');
    vi.setSystemTime(Date.now() + CHECKOUT_EVERY_MS + 1);
    await mutate('two');
    vi.advanceTimersByTime(20_000);
    await settle();
    await mutate('three');
    recorder.stop();

    expect(segments.map(types)).toEqual([
      [EventType.Meta, EventType.FullSnapshot],
      [EventType.IncrementalSnapshot, EventType.IncrementalSnapshot],
      [EventType.Meta, EventType.FullSnapshot, EventType.IncrementalSnapshot],
    ]);
  });

  it('inlines a stylesheet once per page load, then names it', async () => {
    const style = document.createElement('style');
    style.textContent = Array.from({ length: 200 }, (_, i) => `.c${i} { color: red; margin: ${i}px; }`).join('\n');
    document.head.append(style);
    start();
    expect(segments[0].css).toHaveLength(1);
    expect(segments[0].json[1]).toContain('.c199');
    stream.css.ack(segments[0].css);
    recorder.pause('idle');
    recorder.resume();
    recorder.stop();
    const again = segments.at(-1)!;
    expect(again.json[1]).not.toContain('.c199');
    expect(again.json[1]).toMatch(/"_cssText":"sq-css:[0-9a-f]{16}"/);
  });

  it('sends nothing from inside an iframe, blocked or not', async () => {
    document.body.innerHTML = '<p id="p">hello</p><iframe id="b" class="rr-block"></iframe><iframe id="o"></iframe>';
    start();
    vi.advanceTimersByTime(10_000);
    for (const id of ['b', 'o']) {
      const doc = (document.getElementById(id) as HTMLIFrameElement).contentDocument!;
      const div = doc.createElement('div');
      div.textContent = `SECRET-IN-${id}`;
      doc.body.appendChild(div);
    }
    await settle();
    await mutate('after');
    recorder.stop();

    const all = segments.flatMap((s) => s.json);
    expect(all.some((j) => j.includes('SECRET-IN-'))).toBe(false);
    expect(all.some((j) => j.includes('"isAttachIframe"'))).toBe(false);
    expect(all.some((j) => j.includes('"after"'))).toBe(true);
  });

  it('sends nothing at all for a page whose snapshot is too large', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = '<p id="p">hello</p><div id="large"></div>';
    document.getElementById('large')!.textContent = 'x'.repeat(SNAPSHOT_MAX_BYTES);
    start();
    await settle();
    // rrweb snapshots inside record(): the stop is the last word, never a later 'recording'.
    expect(states).toEqual(['too_large']);
    await mutate('changed');
    vi.advanceTimersByTime(CHECKOUT_EVERY_MS * 2);
    await settle();
    expect(segments).toEqual([]);
  });

  describe('hidden inputs', () => {
    const CANARY = 'sqcanarycsrf_8b31';
    for (const [maskInputs, maskText] of [[false, false], [true, false], [true, true]] as const) {
      it(`never records their value (maskInputs ${maskInputs}, maskText ${maskText})`, async () => {
        document.body.innerHTML = `
          <form id="f">
            <input type="hidden" name="csrf" value="${CANARY}">
            <input type="HIDDEN" name="state" value="${CANARY}-upper">
            <input type="text" id="visible" value="visible-value">
          </form>`;
        start({ maskInputs, maskText });
        const later = document.createElement('input');
        later.type = 'hidden';
        later.value = `${CANARY}-added`;
        document.getElementById('f')!.append(later);
        await settle();
        (document.querySelector('input[name=csrf]') as HTMLInputElement).value = `${CANARY}-set`;
        document.querySelector('input[name=csrf]')!.setAttribute('value', `${CANARY}-attr`);
        await settle();
        recorder.stop();

        const text = segments.map((s) => s.json.join(',')).join('\n');
        expect(text).toContain('"type":2');
        expect(text).not.toContain(CANARY);
        if (!maskInputs) expect(text).toContain('visible-value');
      });
    }
  });

  describe('privacy canaries through the ring (Balanced)', () => {
    const CANARIES = {
      email: 'sq.canary.text+19c@example.com',
      card: '4539 5827 1604 3814',
      digits: '8675309123456',
      token: 'sqcanaryhref_3c9d',
      input: 'SqCanaryPrefill-e44',
      password: 'SqCanaryPw-7Q2x9Lk',
    };

    it('never leave the page, before or after the match', async () => {
      document.body.innerHTML = `
        <p id="p">Contact ${CANARIES.email}, card ${CANARIES.card}, ref ${CANARIES.digits}</p>
        <a id="reset" href="https://example.com/reset?token=${CANARIES.token}">reset</a>
        <input id="name" value="${CANARIES.input}"><input id="pw" type="password">`;
      start({ buffer: true, level: 'balanced' });
      (document.getElementById('pw') as HTMLInputElement).value = CANARIES.password;
      document.getElementById('pw')!.dispatchEvent(new Event('change', { bubbles: true }));
      await mutate(`More ${CANARIES.email}`);
      expect(segments).toEqual([]);
      recorder.go();
      await mutate(`Even more ${CANARIES.card}`);
      recorder.stop();
      const text = segments.map((s) => s.json.join(',')).join('\n');
      expect(text).toContain('"type":2');
      for (const value of Object.values(CANARIES)) {
        for (const spelling of [value, value.replace(/ /g, ''), encodeURIComponent(value)]) expect(text).not.toContain(spelling);
      }
    });
  });
});
