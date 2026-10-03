// Replay under stress: mutation floods, 1 MB of CSS, an oversized page, canvas.
import { test, expect, knownGap } from './lib/session.js';
import { SDK, SLOW } from './lib/env.js';
import { Ledger, kb } from './lib/ledger.js';
import { RRWEB, RRWEB_SOURCE } from './lib/captures.js';
import { budget } from './lib/budgets.js';

const size = (e) => JSON.stringify(e).length;
const sum = (xs) => xs.reduce((a, x) => a + x, 0);

test('a mutation flood is bounded and recording survives it', async ({ sq }, testInfo) => {
  const s = await sq.start({ spec: { capture: 'replay' } });
  const page = await s.open('/mutations');
  await s.waitForReplay();
  const from = Date.now();
  const flood = await page.evaluate(() => window.fixture.mutations.flood({ perFrame: 200, seconds: 5 }));
  const to = Date.now();
  await page.getByTestId('nav-forms').click();
  await page.getByTestId('in-text').fill('typed after the flood');
  const c = await s.finish();
  s.expectHealthy(c);

  const during = c.replayEvents.filter((e) => e.type === RRWEB.INCREMENTAL && e.timestamp >= from && e.timestamp <= to + 500);
  const bytes = sum(during.map(size));
  const typedAfter = c.replayEventsOf(RRWEB.INCREMENTAL, RRWEB_SOURCE.INPUT).some((e) => e.timestamp > to);
  const throttled = c.replayEvents.some((e) => e.type === RRWEB.CUSTOM && e.data?.tag === 'sq-throttle');

  const ledger = new Ledger(`Mutation flood, SDK ${SDK.version}`);
  ledger.check('flood ran', flood.mutations > 10000, { info: true, detail: `${flood.mutations} mutations in ${flood.frames} frames, worst frame ${flood.worstFrameMs} ms` });
  budget(ledger, 'flood.raw_bytes', bytes, { detail: `${kb(bytes)} of mutations in ${((to - from) / 1000).toFixed(1)} s, ${c.segments.length} segments` });
  ledger.check('recording survives the flood', typedAfter, { detail: typedAfter ? 'input recorded after the flood' : 'nothing recorded after the flood' });
  ledger.check('throttle marker', throttled, { gap: !SDK.v2, detail: throttled ? 'sq-throttle present' : 'no sq-throttle event', why: '2.0 throttles mutations and marks the gap (5.5)' });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test('1 MB of CSS is inlined once and compressed on the wire', async ({ sq }, testInfo) => {
  const s = await sq.start({ spec: { capture: 'replay' } });
  const page = await s.open('/mpa/heavy.html');
  await s.waitForReplay();
  await page.getByTestId('heavy-input').fill('heavy page typing');
  const c = await s.finish();
  s.expectHealthy(c);

  const snapshots = c.replayEventsOf(RRWEB.FULL_SNAPSHOT);
  const first = snapshots[0] ? size(snapshots[0]) : 0;
  const seg = c.segments.find((x) => x.fullSnapshots > 0);
  const ledger = new Ledger(`Heavy CSS, SDK ${SDK.version}`);
  ledger.check('stylesheet inlined in the snapshot', first > 1_000_000, { detail: `first full snapshot ${kb(first)}` });
  ledger.check('segment compressed on the wire', seg?.encoding === 'gzip', {
    gap: !SDK.v2,
    detail: `${kb(seg?.wireBytes ?? 0)} on the wire, ${kb(seg?.gzipBytes ?? 0)} gzipped`,
    why: '2.0 gzips segments (B1)',
  });
  budget(ledger, 'heavy.snapshot_wire_bytes', seg?.wireBytes ?? 0, { detail: `snapshot segment on the wire` });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test('later checkouts carry CSS by reference', async ({ sq }) => {
  test.skip(!SLOW, 'waits for a 60 s checkout: set SQ_SLOW=1');
  knownGap(!SDK.v2, '1.x re-sends every stylesheet in every checkout; 2.0 sends sq-css:<hash> references (5.5)');
  test.setTimeout(240_000);
  const s = await sq.start({ spec: { capture: 'replay' } });
  const page = await s.open('/mpa/heavy.html');
  await s.waitForReplay();
  for (let i = 0; i < 70; i++) {
    await page.mouse.move(100 + (i % 20) * 10, 200);
    await page.waitForTimeout(1000);
  }
  const c = await s.finish();
  s.expectHealthy(c);
  const snapshots = c.replayEventsOf(RRWEB.FULL_SNAPSHOT).map(size);
  test.info().annotations.push({ type: 'snapshots', description: snapshots.map(kb).join(', ') });
  expect(snapshots.length, 'a checkout happened').toBeGreaterThanOrEqual(2);
  expect(snapshots[1], 'the second snapshot references the CSS').toBeLessThan(snapshots[0] * 0.25);
});

test('an oversized page stops replay cleanly and keeps everything else', async ({ sq }, testInfo) => {
  const s = await sq.start({ spec: { capture: 'replay' } });
  const page = await s.open('/mpa/huge.html?mb=6');
  await page.getByTestId('huge-input').fill('still responsive');
  await expect(page.getByTestId('huge-input')).toHaveValue('still responsive');
  await page.waitForTimeout(3000);
  const c = await s.finish();
  s.expectHealthy(c);

  const ledger = new Ledger(`Oversized page, SDK ${SDK.version}`);
  const biggest = Math.max(0, ...c.segments.map((x) => x.wireBytes));
  const unplayable = c.segments.filter((x) => x.fullSnapshots === 0);
  ledger.check('no unplayable segment sent', c.segments.every((x) => x.fullSnapshots > 0) || c.segments.length === 0, {
    gap: !SDK.v2,
    detail: `${c.segments.length} segments, ${unplayable.length} without a snapshot (event types ${unplayable.flatMap((x) => x.events.map((e) => e.type)).join(',') || 'none'})`,
    why: '1.x sends the Meta event alone, which meters a replay session with nothing to play',
  });
  const cap = SDK.v2 ? 2 * 1024 * 1024 : 4_000_000;
  ledger.check('no segment over the intake cap', biggest <= cap, { detail: `largest ${kb(biggest)}, cap ${kb(cap)}` });
  ledger.check('views still sent', c.views.length > 0, { detail: `${c.views.length} views` });
  const stopped = s.consoleMessages.some((m) => /too large/i.test(m.text));
  const status = c.records.some((r) => r.kind === 'batch_v2' && JSON.stringify(r.json?.events ?? []).includes('too_large'));
  ledger.check('reason reported', status, { gap: !SDK.v2, detail: stopped ? 'console warning only' : 'no reason', why: "2.0 sends status reason 'too_large' (5.5)" });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test('canvas is not recorded without opt-in', async ({ sq }) => {
  const s = await sq.start({ spec: { capture: 'replay' } });
  const page = await s.open('/canvas');
  await s.waitForReplay();
  await page.waitForTimeout(3000);
  const c = await s.finish();
  s.expectHealthy(c);
  expect(c.replayEventsOf(RRWEB.INCREMENTAL, RRWEB_SOURCE.CANVAS_MUTATION), 'canvas mutation events').toEqual([]);
  expect(JSON.stringify(c.replayEvents).includes('rr_dataURL'), 'canvas pixels in the snapshot').toBe(false);
});
