// Two tabs on two subdomains share one session through cookieDomain. The replay lease and the
// segment counter live in a cookie on that domain, so the tabs take turns exactly as same-origin
// tabs do: one records at a time, a takeover opens with a full snapshot, segments never interleave.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { RRWEB } from './lib/captures.js';
import { PORTS } from '../server/origins.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = `http://a.sq.test:${PORTS.site}`;
const B = `http://b.sq.test:${PORTS.site}`;

test('tabs on two subdomains of one session record one at a time, and their segments never interleave', async ({ sq }) => {
  knownGap(!SDK.v2, '1.x keeps the session per tab and records every tab');
  test.skip(test.info().project.name !== 'chromium', 'only Chromium maps *.sq.test to the fixture');
  test.setTimeout(60_000);
  const s = await sq.start({ spec: { capture: 'replay' }, fixture: { init: { cookieDomain: 'sq.test' } } });
  const a = s.page;
  await a.goto(`${A}/`);
  await s.waitForSdk(a);
  await s.waitForReplay();
  await a.getByTestId('home-counter').click();
  await sleep(1500);

  const b = await s.newPage();
  await b.goto(`${B}/mpa/second.html`);
  await s.waitForSdk(b);
  await b.bringToFront();
  await b.getByTestId('second-input').click();
  await b.getByTestId('second-input').fill('typed on the other subdomain');
  await sleep(2500);

  await a.bringToFront();
  await a.getByTestId('home-counter').click();
  await a.getByTestId('home-counter').click();
  await sleep(2500);

  const c = await s.finish();
  expect(c.problems, 'malformed SDK payloads').toEqual([]);
  expect(c.rejected.map((r) => `${r.method} ${r.path} -> ${r.status}`)).toEqual([]);
  expect(s.sdkPageErrors).toEqual([]);
  expect(s.egress.filter((u) => !/^http:\/\/[ab]\.sq\.test:/.test(u)), 'requests outside the fixture').toEqual([]);

  const sids = new Set([...c.segments.map((g) => g.sessionId), ...c.sessionIds]);
  expect(sids.size, 'both subdomains share the session').toBe(1);
  const segs = [...c.segments].sort((x, y) => x.index - y.index);
  expect(new Set(segs.map((g) => g.index)).size, 'segment indexes are unique').toBe(segs.length);
  const span = (g) => {
    const ts = g.events.map((e) => e.timestamp);
    return [Math.min(...ts), Math.max(...ts)];
  };
  for (let i = 1; i < segs.length; i++) {
    expect(span(segs[i])[0], `segment ${segs[i].index} starts before segment ${segs[i - 1].index} ends`).toBeGreaterThanOrEqual(span(segs[i - 1])[1]);
  }
  let origin = null;
  const origins = new Set();
  for (const g of segs) {
    const meta = g.events.find((e) => e.type === RRWEB.META);
    const at = meta ? new URL(meta.data.href).origin : origin;
    if (at !== origin) {
      expect(g.events.slice(0, 2).map((e) => e.type), `segment ${g.index} takes over on ${at}`).toEqual([RRWEB.META, RRWEB.FULL_SNAPSHOT]);
    }
    origin = at;
    origins.add(at);
  }
  expect([...origins].sort(), 'both subdomains recorded').toEqual([A, B]);
});
