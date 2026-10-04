import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SiteQwalityRUM } from '../src/sdk';
import { pageUrl } from '../src/collectors/views';
import { createUrlSanitizer } from '../src/core/url';
import { boot, clearStorage, flush, pagehide, settle, stubNetwork } from './helpers/sdk';
import { FakePerformanceObserver } from './setup';

beforeEach(() => {
  clearStorage();
  history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pageUrl', () => {
  const s = createUrlSanitizer();
  it('drops the fragment unless hash routing keeps a #/route', () => {
    expect(pageUrl('https://x.test/a?q=1#/inbox/42?token=t', s, false)).toBe('https://x.test/a');
    expect(pageUrl('https://x.test/a#/inbox/42?token=t', s, true)).toBe('https://x.test/a#/inbox/42');
    expect(pageUrl('https://x.test/a#!/settings', s, true)).toBe('https://x.test/a#!/settings');
    expect(pageUrl('https://x.test/a#access_token=abc', s, true)).toBe('https://x.test/a');
    expect(pageUrl('https://x.test/a#/access_token=s&token_type=Bearer', s, true)).toBe('https://x.test/a');
  });
});

describe('views', () => {
  it('view_start on load with loading and navigation type, then one per URL change', async () => {
    const net = await boot();
    history.pushState(null, '', '/products?sort=price');
    history.replaceState(null, '', '/products?sort=name');
    history.pushState(null, '', '/products/42');
    await flush();
    const starts = net.events('view_start');
    expect(starts.map((v) => [v.url, v.loading_type, v.navigation_type])).toEqual([
      ['http://localhost:3000/', 'initial_load', 'navigate'],
      ['http://localhost:3000/products', 'route_change', 'push'],
      ['http://localhost:3000/products/42', 'route_change', 'push'],
    ]);
    expect(new Set(starts.map((v) => v.ctx.session_id)).size).toBe(1);
  });

  it('the first view of a session carries referrer, UTM and click-id type; later ones do not', async () => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://search.test/results?q=secret');
    history.replaceState(null, '', '/?utm_source=news&utm_campaign=fall&gclid=abc123&utm_content=a@b.io');
    const net = await boot();
    history.pushState(null, '', '/next');
    await flush();
    const [first, second] = net.events('view_start');
    expect(first).toMatchObject({
      url: 'http://localhost:3000/',
      referrer: 'https://search.test/results',
      utm: { source: 'news', campaign: 'fall', content: '<email>' },
      click_id_type: 'gclid',
    });
    expect(JSON.stringify(net.batches)).not.toContain('abc123');
    expect(second.referrer).toBeUndefined();
    expect(second.utm).toBeUndefined();
  });

  it('a direct visit sends referrer as "", and so does the first view of a rotated session', async () => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('');
    // In memory, so no earlier test's instance hands this page its session.
    const net = await boot({ persistence: 'memory' });
    history.pushState(null, '', '/later');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60_000 });
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.useRealTimers();
    await flush();
    const starts = net.events('view_start');
    const [first, pushed, rotated] = ['navigate', 'push', 'session'].map((n) => starts.find((v) => v.navigation_type === n)!);
    expect(first.referrer).toBe('');
    expect(pushed.referrer).toBeUndefined();
    expect(rotated.ctx.session_id).not.toBe(first.ctx.session_id);
    expect(rotated).toMatchObject({ referrer: '' });
    expect(rotated.utm).toBeUndefined();
  });

  it('routes come from routeName or setView', async () => {
    const net = await boot({ routeName: (path) => (path.startsWith('/users/') ? '/users/:id' : undefined) });
    history.pushState(null, '', '/users/7');
    history.pushState(null, '', '/about');
    SiteQwalityRUM.setView('About page');
    await flush();
    expect(net.events('view_start').map((v) => v.route)).toEqual([undefined, '/users/:id', 'About page']);
  });

  it('hash routing makes one view per #/ route', async () => {
    const net = await boot({ hashRouting: true });
    location.hash = '#/inbox';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    location.hash = '#reviews';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
    expect(net.events('view_start').map((v) => v.url)).toEqual(['http://localhost:3000/', 'http://localhost:3000/#/inbox']);
  });

  it('view_end: interim on hide, final on the next view and on pagehide, seq increasing', async () => {
    const net = await boot();
    await flush();
    history.pushState(null, '', '/two');
    pagehide();
    await settle();
    const ends = net.events('view_end');
    const [first, second] = net.events('view_start').map((v) => v.view_id);
    expect(ends.filter((e) => e.view_id === first).map((e) => [e.seq, e.final])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(ends.filter((e) => e.view_id === second).map((e) => [e.seq, e.final])).toEqual([[1, true]]);
    expect(ends[0]).toMatchObject({ errors: 0, actions: 0, frustrations: 0 });
    expect(typeof ends[0].time_spent_ms).toBe('number');
    expect(typeof ends[0].session_active_ms).toBe('number');
  });

  it('counts errors on the view and measures active time from input', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const net = await boot();
    window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(2000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(30_000);
    SiteQwalityRUM.addError(new Error('x'));
    await flush();
    const end = net.events('view_end')[0];
    expect(end.errors).toBe(1);
    expect(end.active_ms).toBe(7000);
  });

  it('a late vital for the ended initial view goes out as one more final view_end', async () => {
    const net = await boot();
    history.pushState(null, '', '/two');
    FakePerformanceObserver.emit('paint', [{ name: 'first-contentful-paint', startTime: 321 }]);
    await settle();
    await flush();
    const first = net.events('view_start')[0].view_id;
    const late = net.events('view_end').filter((e) => e.view_id === first);
    expect(late.at(-1)).toMatchObject({ final: true, fcp_ms: 321 });
  });

  it('a back-forward cache restore starts a view on a new page load', async () => {
    const net = await boot();
    const before = SiteQwalityRUM.getStatus()!;
    pagehide(true);
    const show = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(show, 'persisted', { value: true });
    window.dispatchEvent(show);
    await flush();
    const restored = net.events('view_start').at(-1)!;
    expect(restored).toMatchObject({ loading_type: 'bfcache_restore', navigation_type: 'back_forward_cache' });
    expect(restored.ctx.session_id).toBe(before.session_id);
    expect(restored.ctx.page_load_id).not.toBe(net.events('view_start')[0].ctx.page_load_id);
  });

  it('the route-change loading time waits for requests and DOM changes to settle', async () => {
    const net = stubNetwork();
    await boot({}, net);
    let release: () => void = () => {};
    net.fetch.mockImplementationOnce(() => new Promise((r) => (release = () => r(new Response('{}')))));
    history.pushState(null, '', '/slow');
    const p = fetch('/api/data');
    await new Promise((r) => setTimeout(r, 150));
    document.body.append(document.createElement('div'));
    release();
    await p;
    await new Promise((r) => setTimeout(r, 250));
    await flush();
    const slow = net.events('view_start').find((v) => String(v.url).endsWith('/slow'))!;
    const end = net.events('view_end').find((e) => e.view_id === slow.view_id)!;
    expect(end.loading_time_ms).toBeGreaterThanOrEqual(140);
    expect(end.loading_time_ms).toBeLessThan(1000);
  });
});
