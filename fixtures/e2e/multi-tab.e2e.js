// Two tabs share one session (the cookie). 2.0.0 records replay in one tab at a time, the
// focused one, and a takeover starts with a full snapshot, so the session's segments play
// back in order without one tab's mutations landing on the other's page.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { RRWEB } from './lib/captures.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('two tabs of one session record one at a time, and their segments never interleave', async ({ sq }) => {
  knownGap(!SDK.v2, '1.x records every tab of a session at once, numbering segments per tab');
  test.setTimeout(60_000);
  const s = await sq.start({ spec: { capture: 'replay' } });
  const a = await s.open('/');
  await s.waitForReplay();
  await a.getByTestId('home-counter').click();
  await sleep(1500);

  // Tab B opens and the user works there.
  const b = await s.newPage();
  await s.open('/mpa/second.html', { page: b });
  await b.bringToFront();
  await b.getByTestId('second-input').click();
  await b.getByTestId('second-input').fill('typed in tab B');
  await sleep(1500);

  // Back to tab A.
  await a.bringToFront();
  await a.getByTestId('home-counter').click();
  await a.getByTestId('home-counter').click();
  await sleep(1500);

  const c = await s.finish();
  s.expectHealthy(c);

  const sids = new Set(c.segments.map((g) => g.sessionId));
  expect(sids.size, 'both tabs share the session').toBe(1);
  const segs = [...c.segments].sort((x, y) => x.index - y.index);
  expect(new Set(segs.map((g) => g.index)).size, 'segment indexes are unique').toBe(segs.length);

  // Each segment's events lie wholly after the previous segment's.
  const span = (g) => {
    const ts = g.events.map((e) => e.timestamp);
    return [Math.min(...ts), Math.max(...ts)];
  };
  for (let i = 1; i < segs.length; i++) {
    const [, prevEnd] = span(segs[i - 1]);
    const [start] = span(segs[i]);
    expect(start, `segment ${segs[i].index} starts before segment ${segs[i - 1].index} ends`).toBeGreaterThanOrEqual(prevEnd);
  }

  // A switch of page is a takeover, and a takeover opens with a Meta and a full snapshot.
  let page = null;
  const pages = new Set();
  for (const g of segs) {
    const meta = g.events.find((e) => e.type === RRWEB.META);
    const href = meta ? new URL(meta.data.href).pathname : page;
    if (href !== page) {
      expect(g.events.slice(0, 2).map((e) => e.type), `segment ${g.index} takes over at ${href}`).toEqual([RRWEB.META, RRWEB.FULL_SNAPSHOT]);
    }
    page = href;
    pages.add(href);
  }
  expect([...pages].sort(), 'both tabs recorded').toEqual(['/', '/mpa/second.html']);
  // Tab A came back after tab B: three runs at least.
  const runs = segs.filter((g, i) => i === 0 || g.events[0]?.type === RRWEB.META).length;
  expect(runs).toBeGreaterThanOrEqual(3);
});
