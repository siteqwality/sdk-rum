// Two tabs on two subdomains share one session through cookieDomain. From 2.1 each records its
// own window, as same-origin tabs do; nothing about replay is shared through the cookie.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { PORTS } from '../server/origins.js';
import { streams, expectPlayable, originsOf } from './lib/streams.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = `http://a.sq.test:${PORTS.site}`;
const B = `http://b.sq.test:${PORTS.site}`;

test('a canvas opt-in cannot multiply its allowance across a shared-domain session', async ({ sq }) => {
  test.skip(test.info().project.name !== 'chromium', 'only Chromium maps *.sq.test to the fixture');
  const s = await sq.start({
    spec: { capture: 'replay', v2: { capture: { canvas: { enabled: true } } } },
    fixture: { init: { cookieDomain: 'sq.test' } },
  });
  const downloads = [];
  s.context.on('request', r => { if (/\/canvas-/.test(r.url())) downloads.push(r.url()); });
  const statuses = [];
  for (const [origin, page] of [[A, s.page], [B, await s.newPage()]]) {
    await page.goto(`${origin}/canvas`);
    await s.waitForSdk(page);
    await expect.poll(() => page.evaluate(() => window.SiteQwalityRUM.getStatus().recording)).toBe('recording');
    await page.waitForTimeout(1200);
    statuses.push(await page.evaluate(() => window.SiteQwalityRUM.getStatus()));
  }
  expect(new Set(statuses.map(s => s.session_id)).size).toBe(1);
  for (const status of statuses) expect(status).toMatchObject({
    sampled: { analyze: true, replay: true },
    dropped: { canvas_cross_origin_budget_unavailable: 1 },
  });
  const c = await s.finish();
  expect(c.problems).toEqual([]);
  expect(c.rejected).toEqual([]);
  expect(s.sdkPageErrors).toEqual([]);
  expect(downloads).toEqual([]);
  expect(c.replayEvents.filter(e => e.type === 3 && e.data?.source === 9)).toEqual([]);
  expect(JSON.stringify(c.replayEvents)).not.toContain('sq-canvas-');
  const all = streams(c.segments);
  expect(new Set(all.map(st => st[0].windowId)).size).toBe(2);
  for (const st of all) expectPlayable(st);
  expect(new Set(all.flatMap(st => [...originsOf(st)]))).toEqual(new Set([A, B]));
});

test('tabs on two subdomains of one session each record their own window', async ({ sq }) => {
  knownGap(!SDK.replayV2, 'before 2.1 one tab records a shared session at a time, through a lease cookie');
  test.skip(test.info().project.name !== 'chromium', 'only Chromium maps *.sq.test to the fixture');
  test.setTimeout(60_000);
  const s = await sq.start({ spec: { capture: 'replay' }, fixture: { init: { cookieDomain: 'sq.test' } } });
  const a = s.page;
  await a.goto(`${A}/`);
  await s.waitForSdk(a);
  await s.waitForReplay();
  await a.getByTestId('home-counter').click();

  const b = await s.newPage();
  await b.goto(`${B}/mpa/second.html`);
  await s.waitForSdk(b);
  await b.getByTestId('second-input').fill('typed on the other subdomain');
  await b.getByTestId('second-input').press('Tab');
  await sleep(1500);
  await a.getByTestId('home-counter').click();
  await sleep(1500);

  const c = await s.finish();
  expect(c.problems, 'malformed SDK payloads').toEqual([]);
  expect(c.rejected.map((r) => `${r.method} ${r.path} -> ${r.status}`)).toEqual([]);
  expect(s.sdkPageErrors).toEqual([]);
  expect(s.egress.filter((u) => !/^http:\/\/[ab]\.sq\.test:/.test(u)), 'requests outside the fixture').toEqual([]);

  const sids = new Set([...c.segments.map((g) => g.sessionId), ...c.sessionIds]);
  expect(sids.size, 'both subdomains share the session').toBe(1);
  const all = streams(c.segments);
  expect(new Set(all.map((st) => st[0].windowId)).size, 'two windows').toBe(2);
  for (const st of all) expectPlayable(st);
  expect(new Set(all.flatMap((st) => [...originsOf(st)])), 'both subdomains recorded').toEqual(new Set([A, B]));
  for (const st of all) expect(originsOf(st).size, 'one origin per window').toBe(1);
});
