// The SDK installs from the snippet, counts views and sessions, and leaves the host page alone.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { ORIGINS } from '../server/origins.js';

const pathOf = (url) => new URL(url).pathname;

test('a view per page and SPA route, one session, URLs minimised', async ({ sq }) => {
  const s = await sq.start({ spec: { capture: 'none' } });
  const page = await s.open('/?utm_source=fixture#top');
  await s.waitForConfig();
  for (const nav of ['nav-products', 'nav-forms', 'nav-network', 'nav-home']) {
    await page.getByTestId(nav).click();
    await expect(page.locator('#view')).toHaveAttribute('data-fixture-page', /.+/);
  }
  await page.getByTestId('nav-products').click();
  await page.getByTestId('product-42').click();
  await page.goBack();
  await expect(page.locator('#view')).toHaveAttribute('data-fixture-page', 'products');
  const c = await s.finish();
  s.expectHealthy(c);

  const paths = c.views.map((v) => pathOf(v.url));
  for (const p of ['/', '/products', '/forms', '/network', '/products/42']) expect(paths).toContain(p);
  for (const v of c.views) expect(v.url, 'query and fragment are removed').toBe(`${ORIGINS.site}${pathOf(v.url)}`);
  expect(c.sessionIds.size, 'one session for one tab').toBe(1);
  expect(c.vitals.length, 'Web Vitals are sent').toBeGreaterThan(0);
  expect(c.segments, 'no replay without a replay rule').toEqual([]);
  expect(c.assets.map((a) => a.path).filter((p) => !p.endsWith('/sdk.min.js')), 'the recorder is never downloaded').toEqual([]);
});

test('a full page load keeps the session and carries replay over', async ({ sq }) => {
  const s = await sq.start({ spec: { capture: 'replay' } });
  const page = await s.open('/');
  const first = await s.waitForReplay();
  await page.getByTestId('link-mpa').click();
  await page.waitForURL('**/mpa/second.html');
  await s.waitForSdk(page);
  await s.waitForReplay({ after: first.seq });
  await page.getByTestId('second-input').fill('typed on the second page');
  const c = await s.finish();
  s.expectHealthy(c);

  expect(c.sessionIds.size, 'both page loads share one session').toBe(1);
  expect(c.views.map((v) => pathOf(v.url))).toEqual(expect.arrayContaining(['/', '/mpa/second.html']));
  // 2.1 numbers segments per page load (design 6.4); 1.x and 2.0 per session.
  const keys = c.segments.map((x) => (SDK.replayV2 ? `${x.sessionId}|${x.windowId}|${x.pageLoadId}|${x.index}` : String(x.index)));
  expect(new Set(keys).size, 'segment keys never repeat').toBe(keys.length);
  if (SDK.replayV2) {
    expect(new Set(c.segments.map((x) => x.pageLoadId)).size, 'two page loads').toBe(2);
    expect(new Set(c.segments.map((x) => x.windowId)).size, 'one window').toBe(1);
  }
  expect(c.segments.filter((x) => x.fullSnapshots > 0).length, 'each page load starts with a full snapshot').toBeGreaterThanOrEqual(2);
});

test('the last measures arrive when the tab closes', async ({ sq }) => {
  const s = await sq.start({ spec: { capture: 'none' } });
  const page = await s.open('/');
  await s.waitForConfig();
  await page.getByTestId('home-slow').click();
  await page.waitForTimeout(300);
  const closing = Date.now();
  const c = await s.finish({ flush: false });
  s.expectHealthy(c);
  const late = c.requests.filter((r) => r.method === 'POST' && r.at >= closing);
  expect(late.length, 'a send on pagehide').toBeGreaterThan(0);
  expect(c.vitals.some((v) => v.inp >= 100), 'INP, reported only on hide, arrived').toBe(true);
});

test('the host page keeps working and gains exactly one global', async ({ sq }) => {
  const s = await sq.start({ spec: { capture: 'replay' } });
  await s.context.addInitScript(() => {
    window.__SQ_BASE_KEYS__ = Object.getOwnPropertyNames(window);
  });
  const page = await s.open('/');
  await s.waitForReplay();
  for (let i = 0; i < 3; i++) await page.getByTestId('home-counter').click();
  await expect(page.getByTestId('counter-value')).toHaveText('3');
  const added = await page.evaluate(() => {
    const base = new Set(window.__SQ_BASE_KEYS__);
    const own = new Set(['__SQ_FIXTURE__', '__SQ_BASE_KEYS__', 'fixture', 'fxLib']);
    return Object.getOwnPropertyNames(window).filter((k) => !base.has(k) && !own.has(k));
  });
  expect(added, 'globals the SDK added').toEqual(['SiteQwalityRUM']);
  s.expectHealthy(await s.finish());
});

test('the classic dashboard snippet records replay', async ({ sq }) => {
  knownGap(!SDK.wave1, '1.0.x: a classic cross-origin script resolves import("./rrweb-*.js") against about:blank');
  const s = await sq.start({ spec: { capture: 'replay' }, fixture: { loader: 'classic' } });
  await s.open('/');
  await s.waitForReplay({ timeout: 8000 });
  s.expectHealthy(await s.finish());
});

test('the snippet coexists with host page globals', async ({ sq }) => {
  knownGap(!SDK.wave1, '1.0.x: the CDN bundle declares top-level names, so it fails beside a host `var t`');
  const s = await sq.start({ spec: { capture: 'none' }, fixture: { loader: 'classic' } });
  const page = await s.open('/mpa/host-globals.html');
  expect(await page.evaluate(() => window.hostGlobals())).toEqual({
    t: 'host-t', e: 'host-e', n: 'host-n', r: 'host-r', $: 'host-$', _: true, o: 'host-o', i: 'host-i',
  });
  // A host script that runs after the SDK must still be able to declare short names.
  await page.addScriptTag({ content: 'var a = 1; let b = 2; function c() {} window.lateHostScript = true;' });
  expect(await page.evaluate(() => window.lateHostScript)).toBe(true);
  await page.getByTestId('hg-button').click();
  const c = await s.finish();
  s.expectHealthy(c);
  expect(c.views.length, 'the SDK still sent a view').toBeGreaterThan(0);
});

test('the harness blocks and reports traffic to any other host', async ({ sq }) => {
  const s = await sq.start({ spec: { capture: 'none' } });
  const page = await s.open('/');
  const outcome = await page.evaluate(() =>
    fetch('https://rum.siteqwality.com/v1/config').then(() => 'reached', (err) => err.name),
  );
  expect(outcome, 'production is unreachable from the fixture').toBe('TypeError');
  expect(s.egress).toEqual(['https://rum.siteqwality.com/v1/config']);
  s.egress.length = 0;
  s.expectHealthy(await s.finish());
});
