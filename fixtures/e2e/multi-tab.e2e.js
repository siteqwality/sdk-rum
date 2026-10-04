// Two tabs share one session (the cookie). From 2.1 each tab records its own window (design 5.3,
// 6.4): segments carry the window and page load ids, number from 0 per page load, and each
// stream plays alone, so the player orders windows instead of one tab recording at a time.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { streams, expectPlayable, pathsOf } from './lib/streams.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('two tabs of one session each record their own window, both at once', async ({ sq }) => {
  knownGap(!SDK.replayV2, 'before 2.1 one tab records a shared session at a time (the lease)');
  test.setTimeout(60_000);
  const s = await sq.start({ spec: { capture: 'replay' } });
  const a = await s.open('/');
  await s.waitForReplay();
  await a.getByTestId('home-counter').click();

  // Tab B opens and the user works there; tab A stays visible (two windows side by side).
  const b = await s.newPage();
  await s.open('/mpa/second.html', { page: b });
  await b.getByTestId('second-input').fill('typed in tab B');
  await b.getByTestId('second-input').press('Tab');
  await sleep(1500);
  const bOpened = Date.now();
  await a.getByTestId('home-counter').click();
  await a.getByTestId('home-counter').click();
  await sleep(1500);

  const c = await s.finish();
  s.expectHealthy(c);

  expect(new Set(c.segments.map((g) => g.sessionId)).size, 'both tabs share the session').toBe(1);
  const all = streams(c.segments);
  expect(new Set(all.map((st) => st[0].windowId)).size, 'two windows').toBe(2);
  for (const st of all) expectPlayable(st);
  const byPath = (p) => all.find((st) => pathsOf(st).has(p));
  expect(byPath('/'), 'tab A recorded').toBeTruthy();
  expect(byPath('/mpa/second.html'), 'tab B recorded').toBeTruthy();
  expect(byPath('/').at(0).windowId).not.toBe(byPath('/mpa/second.html').at(0).windowId);
  // No lease: tab A kept recording after tab B opened.
  const late = byPath('/').flatMap((g) => g.events).filter((e) => e.timestamp > bOpened && e.type === 3);
  expect(late.length, 'tab A events after tab B opened').toBeGreaterThan(0);
});

test('a reload records a new page load in the same window', async ({ sq }) => {
  knownGap(!SDK.replayV2, 'before 2.1 segments are numbered per session, without page load ids');
  const s = await sq.start({ spec: { capture: 'replay' } });
  const page = await s.open('/mpa/second.html');
  const first = await s.waitForReplay();
  await page.getByTestId('second-input').click();
  await page.reload();
  await s.waitForSdk(page);
  await s.waitForReplay({ after: first.seq });
  const c = await s.finish();
  s.expectHealthy(c);
  const all = streams(c.segments);
  expect(all, 'two page loads').toHaveLength(2);
  expect(new Set(all.map((st) => st[0].windowId)).size, 'one window').toBe(1);
  for (const st of all) expectPlayable(st);
  // What the page held at unload went with keepalive, marked as its page load's last.
  expect(all.flat().filter((g) => g.final).length, 'the reloaded page load ended with a final segment').toBe(1);
});
