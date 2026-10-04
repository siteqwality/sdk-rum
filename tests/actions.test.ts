import { describe, it, expect, beforeEach } from 'vitest';
import { getSelector } from '../src/collectors/actions';

function el(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html.trim();
  document.body.appendChild(host);
  return host.firstElementChild!;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

// Shared with the ingestor: what the SDK sends with the setting off, and what
// is stored (and what this SDK sends) with hide_action_text on.
const VECTORS: { html: string; sends: string; stored: string }[] = [
  {
    html: '<button class="btn primary">Send message</button>',
    sends: 'button.btn.primary[Send message]',
    stored: 'button.btn.primary',
  },
  { html: '<button id="save">Save</button>', sends: '#save', stored: '#save' },
  { html: '<a class="nav">Home</a>', sends: 'a.nav[Home]', stored: 'a.nav' },
  {
    html: '<button class="btn" data-sq-action-name="Checkout button">Pay now</button>',
    sends: 'Checkout button',
    stored: 'Checkout button',
  },
  { html: '<div class="x">a[b]</div>', sends: 'div.x[a[b]]', stored: 'div.x' },
];

describe('getSelector shared vectors', () => {
  for (const v of VECTORS) {
    it(`${v.sends} -> ${v.stored}`, () => {
      const target = el(v.html);
      expect(getSelector(target, false)).toBe(v.sends);
      expect(getSelector(target, true)).toBe(v.stored);
    });
  }
});

describe('getSelector text suffix', () => {
  it('uses the first 30 chars of the trimmed text', () => {
    const target = el(`<span>  ${'x'.repeat(40)}  </span>`);
    expect(getSelector(target)).toBe(`span[${'x'.repeat(30)}]`);
  });

  it('never cuts an emoji in half at the cap', () => {
    const target = el(`<span>${'x'.repeat(29)}😀 more</span>`);
    expect(getSelector(target)).toBe(`span[${'x'.repeat(29)}]`);
  });

  it('falls back to aria-label, and hides it too', () => {
    const target = el('<button class="icon" aria-label="Delete Jane"></button>');
    expect(getSelector(target, false)).toBe('button.icon[Delete Jane]');
    expect(getSelector(target, true)).toBe('button.icon');
  });

  it('has no suffix when there is no text or label', () => {
    expect(getSelector(el('<button class="a b c"></button>'))).toBe('button.a.b');
  });

  it('reads an SVG element class attribute', () => {
    const target = el('<svg class="icon close"><path d="M0 0"></path></svg>');
    expect(getSelector(target, true)).toBe('svg.icon.close');
  });
});

describe('getSelector data-sq-action-name', () => {
  it('names a click on a descendant after the closest ancestor', () => {
    const outer = el(
      '<div data-sq-action-name="Outer"><a data-sq-action-name="Open profile"><span class="name">Jane Doe</span></a></div>',
    );
    const span = outer.querySelector('span')!;
    expect(getSelector(span, false)).toBe('Open profile');
    expect(getSelector(span, true)).toBe('Open profile');
  });

  it('wins over the element id', () => {
    expect(getSelector(el('<button id="b1" data-sq-action-name="Buy">x</button>'))).toBe('Buy');
  });

  it('is trimmed and capped at 100 chars', () => {
    const name = 'n'.repeat(150);
    const target = el(`<button data-sq-action-name="  ${name}  ">x</button>`);
    expect(getSelector(target)).toBe('n'.repeat(100));
    expect(getSelector(el('<button data-sq-action-name="  Pay  ">x</button>'))).toBe('Pay');
  });

  it('never cuts an emoji in half at the cap', () => {
    const target = el(`<button data-sq-action-name="${'n'.repeat(99)}😀">x</button>`);
    expect(getSelector(target)).toBe('n'.repeat(99));
  });

  it('never carries square brackets', () => {
    const target = el('<button data-sq-action-name="Add [beta]">x</button>');
    expect(getSelector(target)).toBe('Add (beta)');
  });

  it('falls back to the selector when blank', () => {
    const target = el('<button class="go" data-sq-action-name="   ">Go</button>');
    expect(getSelector(target, false)).toBe('button.go[Go]');
    expect(getSelector(target, true)).toBe('button.go');
  });
});

