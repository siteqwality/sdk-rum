// Privacy canaries (design doc section 10): record a session at each privacy level with every
// planted value on the page, then grep every request the SDK made for every value.
import { test, expect } from './lib/session.js';
import { SDK } from './lib/env.js';
import { site } from './lib/mock.js';
import { Ledger } from './lib/ledger.js';
import { CANARIES, PROOF, GAP_REASONS, expectation, findCanary } from './lib/canaries.js';
import { ORIGINS } from '../server/origins.js';

const v = (id) => CANARIES[id].value;

// capture 'replay' streams from page load; 'replay_on_error' (2.1) buffers in memory until the
// page's first error, then sends the ring.
async function plantedSession(sq, level, capture = 'replay') {
  const s = await sq.start({ spec: { capture, level } });
  await site.requests({ clear: true });
  // Arrive from a third-party page whose referrer policy leaks its full URL.
  const target = `${ORIGINS.site}/forms?token=${v('url_query_token')}&plan=pro#access_token=${v('url_fragment_token')}`;
  const page = s.page;
  await page.goto(`${ORIGINS.third}/third-party/landing.html?token=${v('referrer_token')}&to=${encodeURIComponent(target)}`);
  await page.getByTestId('landing-link').click();
  await page.waitForURL(/\/forms/);
  await s.waitForSdk();
  expect(await page.evaluate(() => document.referrer)).toContain(v('referrer_token'));
  if (capture === 'replay') await s.waitForReplay();

  await page.getByTestId('in-text').fill(v('text_input'));
  await page.getByTestId('in-email').fill(v('email_input'));
  await page.getByTestId('in-password').pressSequentially(v('password_input'));
  await page.getByTestId('in-card').pressSequentially(v('card_input'));
  await page.getByTestId('in-textarea').fill(v('textarea'));
  await page.getByTestId('account-chip').click();
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('form-result')).toHaveText(/Signed up/);
  await page.getByTestId('forms-profile').click();
  await page.getByTestId('forms-search').click();
  await page.getByTestId('forms-error-url').click();
  await page.getByTestId('forms-error-email').click();
  await page.getByTestId('forms-console-email').click();

  await page.getByTestId('nav-iframes').click();
  const same = page.frameLocator('[data-testid=frame-same]');
  const cross = page.frameLocator('[data-testid=frame-cross]');
  await expect(same.getByTestId('frame-text')).toHaveText(v('frame_text'));
  await expect(cross.getByTestId('xframe-text')).toHaveText(v('xframe_text'));
  await same.getByTestId('frame-input').fill('same-origin frame typing');
  await cross.getByTestId('xframe-input').pressSequentially(v('xframe_input'));
  await page.waitForTimeout(500);

  const captures = await s.finish();
  return { s, captures, app: await site.requests() };
}

for (const [level, capture] of ['strict', 'balanced', 'relaxed'].flatMap((l) => [[l, 'replay'], [l, 'replay_on_error']])) {
  const buffered = capture === 'replay_on_error';
  test(`canaries at the ${level} level${buffered ? ', buffered until an error' : ''}`, async ({ sq }, testInfo) => {
    test.skip(buffered && !SDK.replayV2, 'the replay ring arrives with 2.1');
    const { s, captures, app } = await plantedSession(sq, level, capture);
    s.expectHealthy(captures);

    const ledger = new Ledger(`Privacy canaries, ${level}${buffered ? ', buffered' : ''}, SDK ${SDK.version}`);
    for (const [id, { value, guard, where }] of Object.entries(CANARIES)) {
      const hits = findCanary(captures, value);
      const want = expectation(guard, SDK, level);
      const proof = PROOF[id](captures, app, level);
      const seen = hits.length ? `found in ${hits.map((h) => h.kind).join(', ')}: ...${hits[0].context}...` : 'not found';
      if (proof !== true) {
        ledger.check(id, false, { detail: `not exercised: ${proof}` });
      } else if (want === 'allowed') {
        ledger.check(id, true, { info: true, detail: `${seen} (allowed at ${level})` });
      } else {
        ledger.check(id, hits.length === 0, { gap: want === 'gap', detail: seen, why: want === 'gap' ? GAP_REASONS[guard] : where });
      }
    }
    ledger.print(testInfo);
    expect(ledger.failures).toEqual([]);
  });
}
