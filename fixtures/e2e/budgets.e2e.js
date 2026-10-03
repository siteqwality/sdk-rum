// Byte budgets and request counts per page view, per replay minute and for a hidden tab.
import { test, expect } from './lib/session.js';
import { SDK, ACTIVE_SECONDS } from './lib/env.js';
import { Ledger, kb } from './lib/ledger.js';
import { budget } from './lib/budgets.js';

const isCore = (a) => a.path.endsWith('/sdk.min.js');
const posts = (r) => r.method === 'POST';

test('SDK weight and an Observe-only page view', async ({ sq }, testInfo) => {
  const s = await sq.start({ spec: { capture: 'none' } });
  const page = await s.open('/');
  await s.waitForConfig();
  await page.getByTestId('home-counter').click();
  await page.waitForTimeout(1500);
  const c = await s.finish();
  s.expectHealthy(c);

  const ledger = new Ledger(`Observe page view, SDK ${SDK.version}`);
  const core = c.assets.find(isCore);
  budget(ledger, 'core.gzip_bytes', core?.gzipBytes ?? Infinity, { detail: `${kb(core?.wireBytes ?? 0)} minified` });
  const extra = c.assets.filter((a) => !isCore(a));
  ledger.check('no recorder download without a replay rule', extra.length === 0, { detail: extra.map((a) => a.path).join(', ') || 'none' });
  budget(ledger, 'observe.requests', c.requests.length, { detail: c.requests.map((r) => `${r.method} ${r.path}`).join(', ') });
  budget(ledger, 'observe.gzip_bytes', c.bytes(posts).gzip, { detail: `${kb(c.bytes(posts).wire)} as sent` });
  const configPreflight = c.preflights.some((r) => /config/.test(r.path));
  ledger.check('config fetch without a preflight', !configPreflight, { gap: !SDK.v2, detail: `${c.preflights.length} preflights in all`, why: '1.x sends the token in a header to /v1/config (J8)' });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test('an Analyze page view', async ({ sq }, testInfo) => {
  const s = await sq.start({ spec: { capture: 'analyze' } });
  const page = await s.open('/');
  await s.waitForConfig();
  for (const id of ['home-counter', 'home-cta', 'home-dead', 'home-custom']) await page.getByTestId(id).click();
  await page.waitForTimeout(1500);
  const c = await s.finish();
  s.expectHealthy(c);

  const ledger = new Ledger(`Analyze page view, SDK ${SDK.version}`);
  budget(ledger, 'analyze.gzip_bytes', c.bytes(posts).gzip, { detail: `${kb(c.bytes(posts).wire)} as sent in ${c.bytes(posts).requests} requests` });
  ledger.check('actions recorded', c.actions.length >= 3, { detail: `${c.actions.length} actions` });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test(`a replay session over ${ACTIVE_SECONDS} s of activity`, async ({ sq }, testInfo) => {
  test.setTimeout((ACTIVE_SECONDS + 90) * 1000);
  const s = await sq.start({ spec: { capture: 'replay' } });
  const page = await s.open('/');
  await s.waitForReplay();
  const routes = ['nav-products', 'nav-forms', 'nav-home', 'nav-hash', 'nav-console'];
  const started = Date.now();
  for (let i = 0; Date.now() - started < ACTIVE_SECONDS * 1000; i++) {
    const route = routes[i % routes.length];
    await page.getByTestId(route).click();
    if (route === 'nav-forms') await page.getByTestId('in-text').fill(`activity ${i}`);
    await page.mouse.move(80 + ((i * 37) % 600), 120 + ((i * 53) % 400), { steps: 8 });
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(1200);
  }
  const minutes = (Date.now() - started) / 60000;
  const c = await s.finish();
  s.expectHealthy(c);

  const ledger = new Ledger(`Replay session, SDK ${SDK.version}`);
  const recorder = c.assets.filter((a) => !isCore(a));
  budget(ledger, 'recorder.gzip_bytes', recorder.reduce((a, r) => a + r.gzipBytes, 0), { detail: recorder.map((a) => a.path).join(', ') });
  const replay = c.bytes((r) => r.host === 'replay');
  budget(ledger, 'replay.wire_bytes_per_min', Math.round(replay.wire / minutes), {
    detail: `${kb(replay.wire)} sent (${kb(replay.gzip)} if gzipped) in ${minutes.toFixed(2)} min`,
  });
  // Steady state: the first (snapshot) and last (hide) segments are edges, not the rate.
  const segs = [...c.segments].sort((a, b) => a.at - b.at);
  const span = segs.length > 2 ? (segs[segs.length - 1].at - segs[0].at) / 60000 : minutes;
  const steady = segs.length > 2 ? (segs.length - 2) / span : segs.length / minutes;
  budget(ledger, 'replay.segments_per_min', Math.round(steady * 10) / 10, { detail: `${c.segments.length} segments in all` });
  ledger.check('all requests per minute', true, { info: true, detail: `${Math.round(c.requests.length / minutes)} (${c.requests.length} requests, ${c.preflights.length} preflights)` });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test('a hidden tab stays quiet while the page keeps polling', async ({ sq }, testInfo) => {
  const s = await sq.start({ spec: { capture: 'analyze' } });
  const page = await s.open('/network');
  await s.waitForConfig();
  await page.evaluate(() => window.fixture.network.startPolling(500));
  await page.waitForTimeout(1000);
  await s.setVisibility('hidden');
  const from = Date.now() + 1000;
  await page.waitForTimeout(13000);
  const to = Date.now();
  await page.evaluate(() => window.fixture.network.stopPolling());
  const c = await s.finish();
  s.expectHealthy(c);

  const ledger = new Ledger(`Hidden tab, SDK ${SDK.version}`);
  const during = c.requests.filter((r) => r.at >= from && r.at <= to);
  budget(ledger, 'hidden.requests', during.length, { detail: `${((to - from) / 1000).toFixed(0)} s hidden, polling every 500 ms: ${during.map((r) => r.path).join(', ') || 'nothing'}` });
  const polls = c.resources.filter((r) => r.url?.includes('/api/poll')).length + c.network.filter((r) => r.url?.includes('/api/poll')).reduce((a, r) => a + r.n, 0);
  ledger.check('polls still recorded', polls > 10, { detail: `${polls} polls recorded` });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});
