import { describe, it, expect } from 'vitest';
import { EventType } from '@rrweb/types';
import { sanitizeReplayEvent } from '../src/replay/recorder';
import { createUrlSanitizer } from '../src/privacy/url';

const sanitize = createUrlSanitizer();

describe('sanitizeReplayEvent', () => {
  it('agrees with rrweb about which discriminant a Meta event carries', () => {
    // The recorder hardcodes 4 so the lazily-loaded rrweb chunk is not pulled
    // into the core bundle. This is the test that keeps the two in step.
    expect(EventType.Meta).toBe(4);
  });

  it('minimises the href rrweb embeds in a Meta event', () => {
    const event = {
      type: EventType.Meta,
      timestamp: 1,
      data: {
        href: 'https://user:pass@example.com/reset?token=abc#frag',
        width: 1280,
        height: 800,
      },
    };

    const out = sanitizeReplayEvent(event, sanitize) as typeof event;

    expect(out.data.href).toBe('https://example.com/reset');
    expect(out.data.width).toBe(1280);
    expect(out.data.height).toBe(800);
    expect(out.type).toBe(EventType.Meta);
    expect(out.timestamp).toBe(1);
  });

  it('does not mutate the event rrweb handed it', () => {
    const event = {
      type: EventType.Meta,
      timestamp: 1,
      data: { href: 'https://example.com/a?token=abc', width: 1, height: 1 },
    };
    sanitizeReplayEvent(event, sanitize);
    expect(event.data.href).toBe('https://example.com/a?token=abc');
  });

  it('passes every non-Meta event straight through, identity-equal', () => {
    for (const type of [
      EventType.DomContentLoaded,
      EventType.Load,
      EventType.FullSnapshot,
      EventType.IncrementalSnapshot,
      EventType.Custom,
      EventType.Plugin,
    ]) {
      const event = { type, timestamp: 1, data: { href: 'https://x/?t=1' } };
      expect(sanitizeReplayEvent(event, sanitize)).toBe(event);
    }
  });

  it('passes through anything that is not shaped like a Meta event', () => {
    for (const event of [null, undefined, 7, 'meta', {}, { type: 4 }, { type: 4, data: {} }]) {
      expect(sanitizeReplayEvent(event, sanitize)).toBe(event);
    }
  });
});
