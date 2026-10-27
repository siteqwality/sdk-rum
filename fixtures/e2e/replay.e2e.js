// Replay under stress: mutation floods, 1 MB of CSS, an oversized page, canvas.
import { test, expect } from './lib/session.js';
import { SDK } from './lib/env.js';
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
  // The recorder takes an input's value when it changes (rrweb input: 'last').
  await page.getByTestId('in-text').press('Tab');
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
  ledger.check('throttle marker', throttled, { detail: throttled ? 'sq-throttle present' : 'no sq-throttle event' });
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
    detail: `${kb(seg?.wireBytes ?? 0)} on the wire, ${kb(seg?.gzipBytes ?? 0)} gzipped`,
  });
  budget(ledger, 'heavy.snapshot_wire_bytes', seg?.wireBytes ?? 0, { detail: `snapshot segment on the wire` });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test('later checkouts carry CSS by reference', async ({ sq }, testInfo) => {
  test.setTimeout(120_000);
  const s = await sq.start({ spec: { capture: 'replay' } });
  // The page clock runs past the 3 minute streaming checkout without waiting for it.
  await s.page.clock.install();
  const page = await s.open('/mpa/heavy.html');
  await s.waitForReplay();
  for (let i = 0; i < 210; i++) {
    await page.mouse.move(100 + (i % 20) * 10, 200);
    await page.clock.runFor(1_000);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 50));
  }
  const c = await s.finish();
  s.expectHealthy(c);
  const snapshots = c.replayEventsOf(RRWEB.FULL_SNAPSHOT);
  const sizes = snapshots.map(size);
  const ledger = new Ledger(`CSS references, SDK ${SDK.version}`);
  ledger.check('a checkout happened', sizes.length >= 2, { detail: `snapshots ${sizes.map(kb).join(', ')}` });
  ledger.check('the checkout names the stylesheet', (sizes[1] ?? Infinity) < sizes[0] * 0.25, { detail: `${kb(sizes[1] ?? 0)} vs ${kb(sizes[0])}` });
  ledger.check('reference format', /"_cssText":"sq-css:[0-9a-f]{16}"/.test(JSON.stringify(snapshots[1] ?? {})), { detail: 'sq-css:<FNV-1a 64 hex>' });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
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
  ledger.check('nothing sent for the page', c.segments.length === 0, {
    detail: `${c.segments.length} segments, ${unplayable.length} without a snapshot (event types ${unplayable.flatMap((x) => x.events.map((e) => e.type)).join(',') || 'none'})`,
  });
  // The intake takes segments up to 2 MB on the wire.
  const cap = 2 * 1024 * 1024;
  ledger.check('no segment over the intake cap', biggest <= cap, { detail: `largest ${kb(biggest)}, cap ${kb(cap)}` });
  ledger.check('views still sent', c.views.length > 0, { detail: `${c.views.length} views` });
  const stopped = s.consoleMessages.some((m) => /too large/i.test(m.text));
  const status = c.records.some((r) => r.kind === 'batch_v2' && JSON.stringify(r.json?.events ?? []).includes('too_large'));
  ledger.check('reason reported', status, { detail: stopped ? 'console warning only' : 'no reason', why: "status reason 'too_large' (5.5)" });
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
