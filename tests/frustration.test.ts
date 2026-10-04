import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startActionCollector,
  FRUSTRATION_WINDOW_MS,
  type CollectedAction,
} from '../src/collectors/actions';
import { click, el } from './helpers/sdk';

interface Emitted {
  action: CollectedAction;
  context: number;
  at: number;
}

const PRESS_EXPIRES = 3_000;

function collector(options: { hideText?: () => boolean; ignore?: unknown[] } = {}) {
  const emitted: Emitted[] = [];
  let clicks = 0;
  const handle = startActionCollector<number>({
    begin: () => ++clicks,
    emit: (action, context) => emitted.push({ action, context, at: Date.now() }),
    hideText: options.hideText,
    ignoreSelectors: () => options.ignore,
  });
  const verdicts = () => emitted.map((e) => e.action.frustration);
  return { emitted, verdicts, handle, begun: () => clicks };
}

/** A button whose click changes the page, as a working control does. */
function liveButton(html = '<button class="live">Go</button>') {
  const button = el(html);
  button.addEventListener('click', () => button.classList.toggle('on'));
  return button;
}

function clickEvery(target: Element, times: number, gapMs: number) {
  for (let i = 0; i < times; i++) {
    if (i > 0) vi.advanceTimersByTime(gapMs);
    click(target);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  history.replaceState({}, '', '/page');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('click names and timing', () => {
  it('names a click after its interactive ancestor', () => {
    const { emitted } = collector();
    const button = el('<button class="pay">Pay <span class="amount">now</span></button>');
    button.addEventListener('click', () => button.setAttribute('data-x', '1'));
    click(button.querySelector('span')!);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(emitted[0].action).toMatchObject({
      action_type: 'click',
      name: 'Pay now',
      hiddenName: 'button.pay',
      selector: 'button.pay',
    });
  });

  it('counts at the click and emits when the window closes', () => {
    const { emitted, begun } = collector();
    click(liveButton());
    expect(begun()).toBe(1);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS - 1);
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].context).toBe(1);
  });

  it('leaves text off when hideText is on', () => {
    const { emitted } = collector({ hideText: () => true });
    click(liveButton('<button class="send">Hello Jane</button>'));
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(emitted[0].action.name).toBe('button.send');
  });

  it('falls back to the clicked element when nothing interactive encloses it', () => {
    const { emitted } = collector();
    click(el('<div class="card"><p class="body">Text</p></div>').querySelector('p')!);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(emitted[0].action).toMatchObject({ name: 'Text', selector: 'div.card > p.body' });
    expect(emitted[0].action.frustration).toBeUndefined();
  });
});

describe('rage clicks', () => {
  it('10 clicks in 900 ms give exactly one rage_click, on the third click', () => {
    const { verdicts } = collector();
    clickEvery(liveButton(), 10, 100);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts().filter((v) => v === 'rage_click')).toHaveLength(1);
    expect(verdicts()[2]).toBe('rage_click');
    expect(verdicts().filter((v) => v !== undefined)).toHaveLength(1);
  });

  it('a raged burst on a dead control carries only its rage click', () => {
    const { verdicts } = collector();
    clickEvery(el('<button class="dead">Go</button>'), 10, 90);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([
      undefined, undefined, 'rage_click', undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
    ]);
  });

  it('clicks 1.2 s apart never rage', () => {
    const { verdicts } = collector();
    clickEvery(liveButton(), 5, 1_200);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('a burst that keeps going rages once, and a new burst after a pause rages again', () => {
    const { verdicts } = collector();
    const button = liveButton();
    clickEvery(button, 6, 400);
    vi.advanceTimersByTime(1_500);
    clickEvery(button, 3, 100);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts().filter((v) => v === 'rage_click')).toHaveLength(2);
  });

  it('needs the third click within 1000 ms of the first in the window', () => {
    const { verdicts } = collector();
    clickEvery(liveButton(), 3, 600);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined, undefined, undefined]);
  });

  it('alternating between two controls is not rage', () => {
    const { verdicts } = collector();
    const a = liveButton('<button class="a">A</button>');
    const b = liveButton('<button class="b">B</button>');
    for (let i = 0; i < 3; i++) {
      click(a);
      vi.advanceTimersByTime(100);
      click(b);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts().filter((v) => v === 'rage_click')).toHaveLength(2);
  });
});

describe('dead clicks', () => {
  it('a button that changes nothing is a dead click', () => {
    const { verdicts } = collector();
    click(el('<button>Nothing</button>'));
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual(['dead_click']);
  });

  it('a button that toggles a class is not', () => {
    const { verdicts } = collector();
    click(liveButton());
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined]);
  });

  it('a change inside the window counts, one after it does not', () => {
    const { verdicts } = collector();
    const slow = el('<button class="slow">Slow</button>');
    slow.addEventListener('click', () => setTimeout(() => slow.append('!'), 900));
    const late = el('<button class="late">Late</button>');
    late.addEventListener('click', () => setTimeout(() => late.append('!'), 1_100));
    click(slow);
    vi.advanceTimersByTime(2_000);
    click(late);
    vi.advanceTimersByTime(2_000);
    expect(verdicts()).toEqual([undefined, 'dead_click']);
  });

  it('a history change, popstate, hashchange, submit or window blur is a reaction', () => {
    const { verdicts, handle } = collector();
    const reactions: Array<() => void> = [
      () => handle.noteReaction(),
      () => window.dispatchEvent(new PopStateEvent('popstate')),
      () => window.dispatchEvent(new HashChangeEvent('hashchange')),
      () => document.body.dispatchEvent(new Event('submit', { bubbles: true })),
      () => window.dispatchEvent(new Event('blur')),
    ];
    for (const react of reactions) {
      click(el('<button>Go</button>'));
      vi.advanceTimersByTime(300);
      react();
      vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    }
    expect(verdicts()).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('only controls that should react can be dead', () => {
    const { verdicts } = collector();
    // Built before any click: adding them is itself a DOM change.
    const inert = [
      '<div class="plain">x</div>',
      '<input type="text">',
      '<label>x</label>',
      '<select><option>a</option></select>',
    ].map((html) => el(html));
    const controls = [
      '<div role="button">x</div>',
      '<span role="link">x</span>',
      '<input type="submit">',
      '<summary>x</summary>',
      '<div onclick="">x</div>',
    ].map((html) => el(html));
    for (const target of controls) target.addEventListener('click', (e) => e.preventDefault());
    for (const target of [...inert, ...controls]) click(target);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([
      undefined, undefined, undefined, undefined,
      'dead_click', 'dead_click', 'dead_click', 'dead_click', 'dead_click',
    ]);
  });

  it('a modified click, a download or a link to another tab is never dead', () => {
    const { verdicts } = collector();
    click(el('<button>a</button>'), { metaKey: true });
    click(el('<button>b</button>'), { ctrlKey: true });
    click(el('<button>c</button>'), { shiftKey: true });
    click(el('<button>d</button>'), { altKey: true });
    for (const html of ['<a href="/f.pdf" download>f</a>', '<a href="/x" target="_blank">x</a>']) {
      const link = el(html);
      link.addEventListener('click', (e) => e.preventDefault());
      click(link);
    }
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts().every((v) => v === undefined)).toBe(true);
  });

  it('a followed link starts a navigation, a prevented one with no reaction is dead', () => {
    // jsdom logs that it cannot follow the link; the verdict is what matters.
    const { verdicts } = collector();
    const followed = el('<a href="/other" target="_self">Other</a>');
    const prevented = el('<a href="/other">Prevented</a>');
    prevented.addEventListener('click', (e) => e.preventDefault());
    click(followed);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    click(prevented);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined, 'dead_click']);
  });

  it('a same-page fragment link waits for its hashchange', () => {
    const { verdicts } = collector();
    const jump = el('<a href="#reviews">Reviews</a>');
    jump.addEventListener('click', (e) => e.preventDefault());
    const stuck = el('<a href="#nowhere">Stuck</a>');
    stuck.addEventListener('click', (e) => e.preventDefault());
    click(jump);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    click(stuck);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined, 'dead_click']);
  });

  it('a control that opens its menu on pointerdown, mousedown or Enter is not dead', () => {
    const { verdicts } = collector();
    const triggers = ['pointerdown', 'mousedown', 'keydown'].map((type) => {
      const trigger = el(`<button class="${type}">Menu</button>`);
      trigger.addEventListener(type, () => trigger.insertAdjacentHTML('afterend', '<div role="menu"></div>'));
      return { type, trigger };
    });
    for (const { type, trigger } of triggers) {
      const press =
        type === 'keydown'
          ? new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
          : new MouseEvent(type, { bubbles: true });
      trigger.dispatchEvent(press);
      vi.advanceTimersByTime(80);
      click(trigger);
      vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    }
    expect(verdicts()).toEqual([undefined, undefined, undefined]);
  });

  it('a press with no reaction, or a reaction to a press elsewhere, still ends dead', () => {
    const { verdicts } = collector();
    const dead = el('<button class="dead">Dead</button>');
    const other = el('<button class="other">Other</button>');
    dead.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    click(dead);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    other.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(PRESS_EXPIRES);
    document.body.append(document.createElement('span'));
    click(dead);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual(['dead_click', 'dead_click']);
  });

  it('a verdict delayed by a blocked page (alert, confirm) is not dead', () => {
    const { verdicts } = collector();
    click(el('<button>Delete</button>'));
    // A confirm() held the main thread for 3 s; the timer runs late.
    vi.setSystemTime(Date.now() + 3_000);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined]);
  });

  it('pending clicks go out without a dead verdict when the page hides', () => {
    const { emitted, verdicts } = collector();
    click(el('<button>a</button>'));
    vi.advanceTimersByTime(200);
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(emitted).toHaveLength(1);
    expect(verdicts()).toEqual([undefined]);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(emitted).toHaveLength(1);
  });

  it('the tab hiding sends them too', () => {
    const { verdicts } = collector();
    click(el('<button>a</button>'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(verdicts()).toEqual([undefined]);
  });
});

describe('error clicks', () => {
  it('an error within the window makes the latest pending click an error click', () => {
    const { verdicts, handle } = collector();
    click(liveButton('<button class="a">a</button>'));
    vi.advanceTimersByTime(100);
    click(el('<button class="b">b</button>'));
    vi.advanceTimersByTime(500);
    handle.noteError();
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined, 'error_click']);
  });

  it('wins over rage', () => {
    const { verdicts, handle } = collector();
    clickEvery(liveButton(), 3, 100);
    handle.noteError();
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined, undefined, 'error_click']);
  });

  it('an error after the window closes marks nothing', () => {
    const { verdicts, handle } = collector();
    click(liveButton());
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    handle.noteError();
    expect(verdicts()).toEqual([undefined]);
  });
});

describe('opting out', () => {
  it('data-sq-no-frustration on an ancestor turns off rage and dead', () => {
    const { verdicts, handle } = collector();
    const game = el('<div data-sq-no-frustration><button class="mole">Hit</button></div>');
    clickEvery(game.querySelector('button')!, 10, 50);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts().every((v) => v === undefined)).toBe(true);
    click(game.querySelector('button')!);
    handle.noteError();
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts().at(-1)).toBe('error_click');
  });

  it('a remote ignore selector does the same; invalid selectors are skipped', () => {
    const { verdicts } = collector({ ignore: ['[[invalid', 42, '', '.carousel'] });
    const carousel = el('<div class="carousel"><button class="next">Next</button></div>');
    const other = el('<button class="other">Other</button>');
    clickEvery(carousel.querySelector('button')!, 10, 50);
    click(other);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts().slice(0, 10).every((v) => v === undefined)).toBe(true);
    expect(verdicts()[10]).toBe('dead_click');
  });
});

describe('names, selectors, offsets, fields and forms', () => {
  it('prefers data-sq-action-name, then aria-label, then text, cut to 64', () => {
    const { emitted } = collector();
    for (const html of [
      '<button data-sq-action-name="Send [msg]">Send to Jane</button>',
      '<button aria-label="Close dialog">×</button>',
      `<button>${'long '.repeat(30)}</button>`,
    ]) click(liveButton(html));
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(emitted.map((e) => e.action.name)).toEqual(['Send (msg)', 'Close dialog', 'long '.repeat(13).trim().slice(0, 64).trim()]);
  });

  it('builds a stable selector from id, data-testid, data-sq-* and up to two classes, 4 levels', () => {
    const { emitted } = collector();
    const tree = el('<section id="checkout"><div class="row css-1x2y3z col"><form class="pay"><button type="button" class="btn primary big">Pay</button></form></div></section>');
    const button = tree.querySelector('button')!;
    button.addEventListener('click', () => button.classList.toggle('on'));
    click(button);
    const tested = liveButton('<button data-testid="buy-now" class="x">Buy</button>');
    click(tested);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(emitted[0].action.selector).toBe('#checkout > div.row.col > form.pay > button.btn.primary');
    expect(emitted[1].action.selector).toBe('button[data-testid="buy-now"]');
  });

  it('carries the offset inside the element, page coordinates and viewport width', () => {
    const { emitted } = collector();
    const button = liveButton();
    button.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150, x: 100, y: 50, toJSON: () => ({}) });
    click(button, { clientX: 150, clientY: 75 });
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(emitted[0].action).toMatchObject({ offset_pct: [25, 25], viewport_w: innerWidth });
    expect(emitted[0].action.page_xy).toHaveLength(2);
  });

  it('a rage click carries the burst click count', () => {
    const { emitted } = collector();
    clickEvery(liveButton(), 5, 100);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(emitted.find((e) => e.action.frustration === 'rage_click')?.action.click_count).toBe(5);
  });

  it('records field changes and form submits by name, never value', () => {
    const { emitted } = collector();
    const form = el('<form name="signup"><label>Email <input type="email" value="jane@x.io"></label><input type="hidden" name="csrf" value="t"></form>');
    form.querySelector('input[type=email]')!.dispatchEvent(new Event('change', { bubbles: true }));
    form.querySelector('input[type=hidden]')!.dispatchEvent(new Event('change', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true }));
    expect(emitted.map((e) => [e.action.action_type, e.action.name])).toEqual([
      ['input', 'Email'],
      ['submit', 'signup'],
    ]);
    expect(JSON.stringify(emitted)).not.toContain('jane@x.io');
  });

  it('focus moving elsewhere is a reaction; focus the user moves is not', () => {
    const { verdicts } = collector();
    const opener = el('<button>Open</button>');
    const field = el('<input>');
    opener.addEventListener('click', () => field.focus());
    click(opener);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    const dead = el('<button>Dead</button>');
    dead.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    dead.focus();
    click(dead);
    vi.advanceTimersByTime(FRUSTRATION_WINDOW_MS);
    expect(verdicts()).toEqual([undefined, 'dead_click']);
  });
});
