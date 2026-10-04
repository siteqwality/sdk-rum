// Replay privacy (design 7.1): rrweb options per level, DOM attribute cleaning, no iframe content.
import { describe, it, expect } from 'vitest';
import { withoutFrameContent, recordOptions, cleanAttributes, cleanDomEvent, HIDDEN_INPUT_SELECTOR, replayPrivacy } from '../src/replay/privacy';
import { createUrlSanitizer, createTextUrlSanitizer } from '../src/core/url';
import { createScrubber } from '../src/core/sanitize';
import { normalizeConfig } from '../src/core/config';

const meta = (href = 'https://example.com/', timestamp = 1) => ({ type: 4, timestamp, data: { href, width: 1, height: 1 } });

describe('rrweb options (design 5.5)', () => {
  it('samples pointer, scroll, input and media, slims the DOM and never records canvas or other origins', () => {
    const o = recordOptions(replayPrivacy(normalizeConfig({}, 'a').privacy, (s) => s));
    expect(o.sampling).toEqual({ mousemove: 50, scroll: 150, input: 'last', media: 800 });
    expect(o).toMatchObject({ slimDOMOptions: 'all', inlineStylesheet: true, recordCrossOriginIframes: false, recordCanvas: false });
    expect(o).not.toHaveProperty('checkoutEveryNms');
  });
});

describe('withoutFrameContent', () => {
  const frameDoc = document.implementation.createHTMLDocument('frame');
  const nodes = new Map<number, unknown>([
    [1, document],
    [2, document.createElement('div')],
    [7, document.createElement('iframe')],
    [8, frameDoc],
    [9, frameDoc.createElement('div')],
  ]);
  const getNode = (id: number) => nodes.get(id) ?? null;
  const mutation = (data: Record<string, unknown>) => ({
    type: 3,
    timestamp: 1,
    data: { source: 0, adds: [], removes: [], texts: [], attributes: [], ...data },
  });

  it('drops an iframe document and every mutation inside one', () => {
    const attach = mutation({
      isAttachIframe: true,
      adds: [{ parentId: 7, nextId: null, node: { type: 0, id: 8, childNodes: [] } }],
    });
    expect(withoutFrameContent(attach, getNode)).toBeNull();
    expect(
      withoutFrameContent(
        mutation({ adds: [{ parentId: 9, node: { type: 3, id: 10, textContent: 'secret' } }] }),
        getNode,
      ),
    ).toBeNull();
  });

  it('keeps the page part of a mixed mutation', () => {
    const event = mutation({
      adds: [
        { parentId: 2, node: { type: 2, id: 11 } },
        { parentId: 9, node: { type: 2, id: 12 } },
      ],
      removes: [{ parentId: 8, id: 13 }, { parentId: 2, id: 14 }, { parentId: 99, id: 15 }],
      texts: [{ id: 9, value: 'secret' }],
      attributes: [{ id: 2, attributes: { class: 'a' } }],
    });
    const out = withoutFrameContent(event, getNode) as ReturnType<typeof mutation>;
    expect(out.data).toMatchObject({
      adds: [{ parentId: 2 }],
      removes: [{ parentId: 2 }, { parentId: 99 }],
      texts: [],
      attributes: [{ id: 2 }],
    });
    expect(event.data.adds).toHaveLength(2);
  });

  it('drops input, clicks and pointer positions inside an iframe', () => {
    const input = { type: 3, timestamp: 1, data: { source: 5, id: 9, text: 'secret' } };
    const click = { type: 3, timestamp: 1, data: { source: 2, type: 2, id: 2, x: 1, y: 1 } };
    const moves = {
      type: 3,
      timestamp: 1,
      data: { source: 1, positions: [{ id: 2 }, { id: 9 }] },
    };
    expect(withoutFrameContent(input, getNode)).toBeNull();
    expect(withoutFrameContent(click, getNode)).toBe(click);
    expect(withoutFrameContent(moves, getNode)).toMatchObject({
      data: { positions: [{ id: 2 }] },
    });
  });

  it('passes page events through untouched', () => {
    const event = mutation({ adds: [{ parentId: 2, node: { type: 2, id: 11 } }] });
    expect(withoutFrameContent(event, getNode)).toBe(event);
    expect(withoutFrameContent(meta(), getNode)).toEqual(meta());
  });
});

describe('replay privacy (7.1)', () => {
  const privacy = (over: Record<string, unknown> = {}) => normalizeConfig({ privacy: over }, 'a').privacy;
  const mask = createScrubber(['email', 'card', 'digits9'], true);

  it('Balanced: inputs masked, text visible with patterns masked by stars', () => {
    const o = recordOptions(replayPrivacy(privacy({ level: 'balanced' }), mask));
    expect(o.maskAllInputs).toBe(true);
    expect(o.maskTextSelector).toBe('*');
    expect(o.maskTextFn!('mail jane@x.io ref 123456789', null)).toBe('mail ********* ref *********');
    expect(o.maskTextFn!('plain', null)).toBe('plain');
  });

  it('Strict: all text masked except unmask selectors; media blocked', () => {
    document.body.innerHTML = '<p class="public">Price</p><p>Name</p>';
    const o = recordOptions(replayPrivacy(privacy({ level: 'strict', unmask_selectors: ['.public'], block_selectors: ['[data-sq-block]', 'not a selector ::'] }), mask));
    const [pub, priv] = Array.from(document.querySelectorAll('p')) as HTMLElement[];
    expect(o.maskTextFn!('Price', pub)).toBe('Price');
    expect(o.maskTextFn!('Jane Doe', priv)).toBe('**** ***');
    expect(o.blockSelector).toBe(`${HIDDEN_INPUT_SELECTOR},[data-sq-block],img,video,audio,picture,svg`);
  });

  it('Relaxed: no pattern masking; mask selectors still apply', () => {
    document.body.innerHTML = '<p class="secret">x</p>';
    const o = recordOptions(replayPrivacy(privacy({ level: 'relaxed', mask_selectors: ['.secret'] }), mask));
    expect(o.maskTextFn!('a@b.io', document.body)).toBe('a@b.io');
    expect(o.maskTextFn!('hide me', document.querySelector('p') as HTMLElement)).toBe('**** **');
  });

  it('legacy Custom follows the flags, and card fields stay masked without mask_inputs', () => {
    const o = recordOptions(replayPrivacy(privacy({ level: null, mask_inputs: false, mask_text: false, pii_patterns: [] }), mask));
    expect(o.maskAllInputs).toBe(false);
    expect(o.maskInputOptions).toEqual({ password: true, email: true, tel: true });
    expect(o.blockSelector).toContain('input[autocomplete^="cc-" i]');
    expect(o.maskTextSelector).toBeUndefined();
  });

  it('ignore_input_selectors become rrweb ignoreSelector', () => {
    expect(recordOptions(replayPrivacy(privacy({ ignore_input_selectors: ['.otp'] }), mask)).ignoreSelector).toBe('.otp');
  });
});

describe('DOM attributes in replay', () => {
  const url = createUrlSanitizer();
  const text = createTextUrlSanitizer(url);
  const scrub = createScrubber(['email'], true);

  it('minimises URL attributes, srcset and style urls, and scrubs other attributes', () => {
    const attrs: Record<string, unknown> = {
      href: 'https://x.test/reset?token=abc#f',
      src: '/p.svg?sig=1',
      srcset: 'https://x.test/a.png?s=1 1x, https://x.test/b.png?s=2 2x',
      style: 'background: url(https://x.test/bg.png?k=1)',
      title: 'Mail jane@x.io',
      _cssText: '.a{background:url(https://x.test/c.png?t=1)}',
      rr_width: '10px',
    };
    cleanAttributes(attrs, url, text, scrub);
    expect(attrs).toEqual({
      href: 'https://x.test/reset',
      src: '/p.svg',
      srcset: 'https://x.test/a.png 1x, https://x.test/b.png 2x',
      style: 'background: url(https://x.test/bg.png)',
      title: 'Mail *********',
      _cssText: '.a{background:url(https://x.test/c.png)}',
      rr_width: '10px',
    });
  });

  it('walks full snapshots and mutation adds and attributes', () => {
    const clean = (a?: Record<string, unknown>) => cleanAttributes(a, url, text);
    const nodes: boolean[] = [];
    const snapshot = { type: 2, data: { node: { childNodes: [{ attributes: { href: '/a?x=1' }, childNodes: [{ attributes: { src: '/i?y=2' } }] }] } } };
    cleanDomEvent(snapshot, (a, node) => (nodes.push(node), clean(a)));
    expect(JSON.stringify(snapshot)).not.toContain('?');
    const mutation = { type: 3, data: { source: 0, adds: [{ node: { attributes: { href: '/b?t=1' } } }], attributes: [{ attributes: { src: '/c?t=2', style: { 'background-image': 'url(https://x.test/d?t=3)' } } }] } };
    cleanDomEvent(mutation, (a, node) => (nodes.push(node), clean(a)));
    expect(JSON.stringify(mutation)).not.toContain('t=');
    // Serialized nodes are told apart from attribute changes (CSS references use it).
    expect(nodes).toEqual([true, true, true, true, false]);
  });
});
