// Two tabs on two subdomains share one session through cookieDomain. From 2.1 each records its
// own window, as same-origin tabs do; nothing about replay is shared through the cookie.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { PORTS } from '../server/origins.js';
import { streams, expectPlayable, originsOf } from './lib/streams.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = `http://a.sq.test:${PORTS.site}`;
const B = `http://b.sq.test:${PORTS.site}`;

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
