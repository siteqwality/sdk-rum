// Console noise: the page's console output is untouched, and 2.0 keeps only what its caps allow.
import { test, expect } from './lib/session.js';
import { SDK } from './lib/env.js';
import { Ledger } from './lib/ledger.js';

async function consoleRun(sq, fixture) {
  const s = await sq.start({ spec: { capture: 'analyze' }, fixture });
  const page = await s.open('/console');
  if (fixture.sdk !== 'off') await s.waitForConfig();
  const before = s.consoleMessages.length;
  const made = await page.evaluate(() => window.fixture.console.runAll());
  await page.waitForTimeout(500);
  const seen = s.consoleMessages.slice(before).filter((m) => !m.text.startsWith('[SiteQwality'));
  return { s, made, seen };
}

test('console output is unchanged by the SDK and within capture caps', async ({ sq }, testInfo) => {
  const off = await consoleRun(sq, { sdk: 'off' });
  const on = await consoleRun(sq, {});
  const c = await on.s.finish();
  on.s.expectHealthy(c);

  const ledger = new Ledger(`Console, SDK ${SDK.version}`);
  ledger.check('same console output', on.seen.length === off.seen.length, {
    detail: `${on.made} calls; ${off.seen.length} messages without the SDK, ${on.seen.length} with it`,
  });
  ledger.check('no SDK errors from awkward values', on.s.sdkPageErrors.length === 0, { detail: `${on.s.sdkPageErrors.length}` });
  const rows = c.console;
  if (SDK.v2) {
    const byLevel = rows.reduce((a, r) => ({ ...a, [r.level]: (a[r.level] || 0) + 1 }), {});
    ledger.check('levels follow config (error, warn)', Object.keys(byLevel).every((l) => l === 'error' || l === 'warn'), { detail: JSON.stringify(byLevel) });
    ledger.check('at most 50 per level per 10 s', Object.values(byLevel).every((n) => n <= 50), { detail: JSON.stringify(byLevel) });
    const repeated = rows.filter((r) => r.message?.includes('fx:console repeated line'));
    ledger.check('identical lines fold', repeated.length <= 2 && repeated.reduce((a, r) => a + r.repeat, 0) >= 50, {
      detail: `${repeated.length} rows, repeat ${repeated.reduce((a, r) => a + r.repeat, 0)}`,
    });
    ledger.check('entries at most 2 KB', rows.every((r) => (r.message || '').length <= 2048), { detail: `longest ${Math.max(0, ...rows.map((r) => (r.message || '').length))}` });
  } else {
    ledger.check('console capture', true, { info: true, detail: `1.x records no console (${rows.length} rows)` });
  }
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});
