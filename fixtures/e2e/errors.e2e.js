// Every error kind the fixture can raise, and what each SDK version must do with it.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { Ledger } from './lib/ledger.js';

// match: text that identifies the error. noise: a Wave 1 D9 rule that must drop it from 1.1 on.
// gapUntil: the first version that meets the target ('wave1' or 'v2').
const KINDS = {
  sync: { match: 'fx:sync' },
  type_error: { match: 'fxTypeError' },
  async_timeout: { match: 'fx:async-timeout' },
  promise_error: { match: 'fx:promise-error' },
  promise_string: { match: 'fx:promise-string' },
  promise_object: { match: 'fx:promise-object', gapUntil: 'v2', why: '1.x sends "[object Object]"; 2.0 serialises the reason (5.7)' },
  async_fn: { match: 'fx:async-fn' },
  throw_string: { match: 'fx:throw-string' },
  range_error: { match: 'Maximum call stack' },
  cause: { match: 'fx:cause outer' },
  external: { match: 'fx:external' },
  handled: { match: 'fx:handled via addError' },
  handled_nonerror: { match: 'fx:handled-nonerror', gapUntil: 'wave1', why: '1.0.x sends an empty message for addError(non-Error) (F7)' },
  script_error: { match: 'Script error', noise: 'N2' },
  ext_chrome: { match: 'fx:ext-chrome', noise: 'N3' },
  ext_moz: { match: 'fx:ext-moz', noise: 'N3' },
  ext_safari: { match: 'fx:ext-safari', noise: 'N3' },
  resize_observer: { match: 'ResizeObserver loop', noise: 'N1' },
};
// Raised and reported, with no target yet: resource failures and console.error.
const REPORT_ONLY = {
  resource_img: 'fx-image-',
  resource_script: 'fx-script-',
  resource_css: 'fx-style-',
  console_error: 'fx:console-error',
};

const reached = (until) => (until === 'v2' ? SDK.v2 : until === 'wave1' ? SDK.wave1 : true);

test('every error kind, captured or dropped as the SDK version promises', async ({ sq }, testInfo) => {
  const s = await sq.start({ spec: { capture: 'none' } });
  const page = await s.open('/errors');
  await s.waitForConfig();
  const fire = (id) => page.evaluate((k) => window.fixture.errors.fire(k), id);
  for (const id of [...Object.keys(KINDS), ...Object.keys(REPORT_ONLY), 'burst']) {
    await fire(id);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(1000);
  const addErrorString = await page.evaluate(() => window.fixture.results.addErrorString);
  const c = await s.finish();
  s.expectHealthy(c);

  const ledger = new Ledger(`Errors, SDK ${SDK.version}`);
  const all = c.errors;
  const text = (e) => `${e.message}\n${e.stack}`;
  for (const [id, k] of Object.entries(KINDS)) {
    const got = all.filter((e) => text(e).includes(k.match));
    if (k.noise) {
      ledger.check(id, got.length === 0, {
        gap: !SDK.wave1,
        detail: `${got.length} sent`,
        why: `noise rule ${k.noise}, dropped from 1.1 (D9)`,
      });
    } else {
      ledger.check(id, got.length === 1, {
        gap: !reached(k.gapUntil),
        detail: `${got.length} sent${got[0] ? `: ${JSON.stringify(got[0].message).slice(0, 70)}` : ''}`,
        why: reached(k.gapUntil) ? '' : k.why,
      });
    }
  }
  for (const [id, needle] of Object.entries(REPORT_ONLY)) {
    const got = all.filter((e) => text(e).includes(needle));
    ledger.check(id, true, { info: true, detail: `${got.length} sent (no target yet)` });
  }

  const burst = all.filter((e) => e.message?.includes('fx:burst'));
  ledger.check('burst', burst.length <= 10, {
    gap: !SDK.wave1,
    detail: `30 raised, ${burst.length} events, ${burst.reduce((a, e) => a + e.repeat, 0)} counted`,
    why: 'burst limit: 10, then 1 per 10 s (F6)',
  });
  ledger.check('addError never throws', addErrorString && !addErrorString.threw, { detail: JSON.stringify(addErrorString) });

  const stack = (id) => all.find((e) => text(e).includes(KINDS[id].match))?.stack || '';
  ledger.check('stack of a thrown Error', /errors\.js:\d+:\d+/.test(stack('sync')), { detail: stack('sync').split('\n')[1]?.trim() });
  ledger.check('stack names in-app frames', /validateOrder.*assets\/lib\.js/s.test(stack('external')), {
    detail: stack('external').split('\n').slice(1, 3).map((l) => l.trim()).join(' | '),
  });
  const cause = all.find((e) => e.message?.includes('fx:cause outer'));
  ledger.check('cause chain', JSON.stringify(cause?.cause ?? '').includes('fx:cause-inner'), {
    info: !SDK.v2,
    detail: cause?.cause ? 'cause sent' : 'no cause field',
  });
  const sessions = new Set(all.map((e) => e.sessionId)).size;
  ledger.check('one session', sessions === 1, { detail: `${sessions} session ids on errors` });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);
});

test('an error thrown before the SDK loads is captured by the snippet stub', async ({ sq }) => {
  knownGap(!SDK.wave1, '1.0.x ignores errors the snippet stub queued (F7)');
  const s = await sq.start({ spec: { capture: 'none' } });
  await s.open('/mpa/early-error.html');
  await s.waitForConfig();
  const c = await s.finish();
  s.expectHealthy(c);
  expect(c.errors.filter((e) => e.message?.includes('fx:early'))).toHaveLength(1);
});

test('an errored-sessions rule replays what led up to the error', async ({ sq }) => {
  knownGap(!SDK.replayV2, 'before 2.1 recording starts after the error; the 2.1 replay ring flushes a buffer from page load (B3)');
  const s = await sq.start({ spec: { capture: 'replay_on_error' } });
  const page = await s.open('/errors');
  await s.waitForConfig();
  const loadedAt = Date.now();
  await page.mouse.move(200, 200);
  await page.getByRole('heading', { name: 'Errors' }).click();
  await page.waitForTimeout(3000);
  const erroredAt = Date.now();
  await page.getByTestId('err-sync').click();
  await s.waitForReplay({ timeout: 12000 });
  const c = await s.finish();
  s.expectHealthy(c);
  const first = Math.min(...c.replayEvents.map((e) => e.timestamp));
  expect(first, 'replay starts before the error, near page load').toBeLessThan(erroredAt - 2500);
  expect(first).toBeLessThan(loadedAt + 1000);
});
