import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiteQwalityRUM } from '../src/init';
import {
  click,
  details,
  el,
  init,
  measures,
  resetSdk,
  serveConfig,
  settle,
  MATCH_ALL,
  type Registry,
} from './helpers/harness';

const h = vi.hoisted(() => ({
  transports: [] as Array<{ endpoint: string; events: unknown[] }>,
}));

vi.mock('../src/transport', () => ({
  TransportManager: class {
    events: unknown[] = [];
    constructor(public endpoint: string) {
      h.transports.push(this);
    }
    enqueue(event: unknown) {
      this.events.push(event);
    }
  },
}));
vi.mock('../src/collectors/vitals', () => ({ startVitalsCollector: vi.fn() }));

const registry = h.transports as Registry;
const actions = () => details(registry).filter((e) => e.type === 'action');

beforeEach(() => {
  vi.useFakeTimers();
  resetSdk();
  h.transports.length = 0;
  document.body.innerHTML = '';
  history.replaceState({}, '', '/shop');
});

afterEach(() => {
  resetSdk();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(filters: object[] = [MATCH_ALL], settings: Record<string, unknown> = {}) {
  serveConfig(filters, settings);
  await init();
  await settle();
}

describe('click detail through init', () => {
  it('a sent error right after a click makes it an error click', async () => {
    await start();
    const coupon = el('<button class="coupon">Apply</button>');
    coupon.addEventListener('click', () => {
      SiteQwalityRUM.addError(new TypeError("Cannot read properties of undefined (reading 'discount')"));
      coupon.classList.add('tried');
    });
    click(coupon);
    vi.advanceTimersByTime(1_000);
    expect(actions().map((a) => a.frustration)).toEqual(['error_click']);
  });

  it('a filtered noise error marks nothing', async () => {
    await start();
    const live = el('<button class="live">Go</button>');
    live.addEventListener('click', () => live.classList.toggle('on'));
    click(live);
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' }));
    vi.advanceTimersByTime(1_000);
    expect(actions().map((a) => a.frustration)).toEqual([undefined]);
  });

  it('applies the remote frustration_ignore_selectors', async () => {
    await start([MATCH_ALL], { frustration_ignore_selectors: ['.game'] });
    const mole = el('<div class="game"><button class="mole">Hit</button></div>').querySelector('button')!;
    for (let i = 0; i < 5; i++) {
      click(mole);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(1_000);
    expect(actions().every((a) => a.frustration === undefined)).toBe(true);
    expect(actions()).toHaveLength(5);
  });

  it('counts the click at once, before its detail goes out', async () => {
    await start();
    click(el('<button>Buy</button>'));
    history.pushState({}, '', '/cart');
    expect(measures(registry).at(-1)).toMatchObject({ type: 'view', action_count: 1 });
    expect(actions()).toHaveLength(0);
  });

  it('keeps the view and time of the click, even if a route change follows', async () => {
    await start();
    const firstView = measures(registry)[0].view_id;
    const clickedAt = Date.now();
    click(el('<a href="/cart" class="nav">Cart</a>'));
    history.pushState({}, '', '/cart');
    vi.advanceTimersByTime(1_000);
    const [action] = actions();
    expect(action.view_id).toBe(firstView);
    expect(action.timestamp).toBe(clickedAt);
    expect(action.url).toBe('http://localhost:3000/shop');
    expect(action.frustration).toBeUndefined();
  });

  it('counts but sends no click detail without a matching rule', async () => {
    await start([]);
    click(el('<button>Buy</button>'));
    vi.advanceTimersByTime(1_000);
    expect(actions()).toHaveLength(0);
    history.pushState({}, '', '/next');
    expect(measures(registry).at(-1)!.action_count).toBe(1);
  });

  it('sends a custom action at once', async () => {
    await start();
    SiteQwalityRUM.addAction('checkout-clicked', { step: '2' });
    expect(actions()).toEqual([
      expect.objectContaining({ action_type: 'custom', action_target: 'checkout-clicked', custom_attributes: { step: '2' } }),
    ]);
  });

  it('ignores a custom action without a string name', async () => {
    await start();
    SiteQwalityRUM.addAction(42 as unknown as string);
    SiteQwalityRUM.addAction('');
    expect(actions()).toHaveLength(0);
  });
});
