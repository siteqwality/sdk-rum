// fetch and XHR: the page sees exactly what it would without the SDK, and the SDK records
// what its version promises (1.x: resource timing rows; 2.0: network rows with status, 5.6).
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { site } from './lib/mock.js';
import { Ledger } from './lib/ledger.js';
import { ORIGINS } from '../server/origins.js';

// What a 2.0 network row must say for each call: [path, status, error_kind].
const ROWS = {
  fetch_ok: ['/api/ok', 200], fetch_404: ['/api/notfound', 404], fetch_500: ['/api/fail', 500],
  fetch_drop: ['/api/drop', 0, 'network'], fetch_abort: ['/api/slow', 0, 'abort'], fetch_timeout: ['/api/slow', 0, 'timeout'],
  fetch_cors: ['/api/nocors', 0, 'network'], xhr_ok: ['/api/ok', 200], xhr_500: ['/api/fail', 500],
  xhr_drop: ['/api/drop', 0, 'network'], xhr_abort: ['/api/slow', 0, 'abort'], xhr_timeout: ['/api/slow', 0, 'timeout'],
};
const pathOf = (url) => new URL(url, ORIGINS.site).pathname;

test('app requests behave the same with the SDK, which adds no headers by default', async ({ sq }, testInfo) => {
  const s = await sq.start({ spec: { capture: 'analyze' } });
  const page = await s.open('/network');
  await s.waitForConfig();
  await site.requests({ clear: true });
  const results = await page.evaluate(() => window.fixture.network.runAll());
  const expected = await page.evaluate(() => window.fixture.network.EXPECTED);
  const app = await site.requests();
  await page.waitForTimeout(500);
  const c = await s.finish();
  s.expectHealthy(c);

  const ledger = new Ledger(`Network, SDK ${SDK.version}`);
  for (const [id, want] of Object.entries(expected)) {
    const got = results[id] || {};
    const same = Object.entries(want).every(([k, v]) => got[k] === v);
    ledger.check(`page sees ${id}`, same, { detail: JSON.stringify({ ...got, ms: undefined, message: undefined }) });
  }
  const traced = app.filter((r) => Object.keys(r.headers).length);
  ledger.check('no headers injected', traced.length === 0, { detail: traced.map((r) => `${r.path} ${JSON.stringify(r.headers)}`).join('; ') || 'none' });

  const recorded = [...c.resources, ...c.network];
  // Recording its own sends fed the 2026-10-03 hidden-tab loop. The CDN script load is the page's own.
  const own = recorded.filter((r) => [ORIGINS.ingest, ORIGINS.replay].some((h) => r.url?.startsWith(h)));
  ledger.check('own sends never recorded', own.length === 0, { detail: own.map((r) => r.url).join(', ') || `none of ${recorded.length} rows` });
  ledger.check('recorded URLs minimised', recorded.every((r) => !String(r.url).includes('?')), {
    detail: recorded.filter((r) => String(r.url).includes('?')).map((r) => r.url).join(', ') || 'no query strings',
  });
  for (const id of ['fetch_ok', 'fetch_500', 'xhr_ok']) {
    const path = { fetch_ok: '/api/ok', fetch_500: '/api/fail', xhr_ok: '/api/ok' }[id];
    ledger.check(`recorded ${id}`, recorded.some((r) => pathOf(r.url) === path), { detail: path });
  }
  if (SDK.v2) {
    for (const [id, [path, status, kind]] of Object.entries(ROWS)) {
      const row = c.network.find((n) => pathOf(n.url) === path && n.status === status && (!kind || n.errorKind === kind));
      ledger.check(`network row ${id}`, Boolean(row), { detail: `${path} status ${status}${kind ? ` ${kind}` : ''}` });
    }
  } else {
    const failed = ['/api/drop', '/api/slow', '/api/nocors'].filter((p) => c.resources.some((r) => pathOf(r.url) === p));
    ledger.check('failed requests', true, { info: true, detail: `1.x resource rows for: ${failed.join(', ') || 'none'} (no status in 1.x)` });
  }
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test('failed requests are recorded for every session, without a rule', async ({ sq }) => {
  knownGap(!SDK.v2, '1.x records requests only for sessions a rule matched; 2.0 sends failures at Observe (5.4)');
  const s = await sq.start({ spec: { capture: 'none' } });
  const page = await s.open('/network');
  await s.waitForConfig();
  for (const id of ['fetch_ok', 'fetch_500', 'fetch_drop', 'xhr_500']) await page.getByTestId(`net-${id}`).click();
  await page.waitForTimeout(800);
  const c = await s.finish();
  s.expectHealthy(c);
  const rows = [...c.network, ...c.resources];
  expect(rows.some((r) => pathOf(r.url) === '/api/fail'), 'the 500 is recorded').toBe(true);
  expect(rows.some((r) => pathOf(r.url) === '/api/drop'), 'the network failure is recorded').toBe(true);
  expect(rows.some((r) => pathOf(r.url) === '/api/ok'), 'a success is Analyze only').toBe(false);
});

test('polling aggregates into a few rows', async ({ sq }, testInfo) => {
  knownGap(!SDK.v2, '1.x sends one row per request; 2.0 aggregates successful repeats per 30 s (5.6)');
  const s = await sq.start({ spec: { capture: 'analyze' } });
  const page = await s.open('/network');
  await s.waitForConfig();
  await page.evaluate(() => window.fixture.network.startPolling(250));
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.fixture.network.stopPolling());
  const c = await s.finish();
  s.expectHealthy(c);
  const rows = [...c.network, ...c.resources].filter((r) => pathOf(r.url) === '/api/poll');
  const calls = rows.reduce((a, r) => a + (r.n ?? 1), 0);
  testInfo.annotations.push({ type: 'poll rows', description: `${rows.length} rows for ${calls} calls` });
  expect(calls, 'every poll is counted').toBeGreaterThanOrEqual(15);
  expect(rows.length, 'rows for about 24 polls in 6 s').toBeLessThanOrEqual(2);
});
