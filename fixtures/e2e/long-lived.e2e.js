// A tab left open on a page that ticks a clock every second (thesecretsproject, 2026-10-03, about
// 190 replay requests per tab per hour). A simulated hour hidden, or visible with no input, must
// cost a bounded number of requests; the tab resumes with a full snapshot.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';
import { Ledger } from './lib/ledger.js';

const MINUTE = 60_000;
// Real time on the Node side: with the page clock installed, page.waitForTimeout is not.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openClock(sq) {
  const s = await sq.start({ spec: { capture: 'replay' } });
  await s.page.clock.install();
  const page = await s.open('/mpa/ticking-clock.html');
  await s.waitForReplay();
  await page.getByTestId('clock-button').click();
  await sleep(1000);
  return { s, page };
}

// Runs the page's fake clock a minute at a time, letting real time pass so requests can land.
async function simulate(page, minutes) {
  for (let m = 0; m < minutes; m++) {
    await page.clock.runFor(MINUTE);
    await sleep(25);
  }
}

const requestsSince = async (s, seq) => (await s.summary()).filter((r) => r.seq > seq && r.kind !== 'preflight');

test('a hidden tab with a ticking clock goes quiet for the hour, then resumes from a snapshot', async ({ sq }, testInfo) => {
  knownGap(!SDK.v2, '1.x keeps recording and sending segments while hidden');
  test.setTimeout(120_000);
  const { s, page } = await openClock(sq);
  await s.setVisibility('hidden');
  await sleep(1500);
  // The hide flush and stragglers observed while hiding (a long frame) go out in the first minute.
  const hidden = await s.lastSeq();
  await simulate(page, 1);
  await sleep(1000);
  const first = await requestsSince(s, hidden);
  const from = await s.lastSeq();
  await simulate(page, 59);
  await sleep(1000);
  const rest = await requestsSince(s, from);
  const ledger = new Ledger(`Hidden hour with a ticking clock, SDK ${SDK.version}`);
  const list = (rs) => rs.map((r) => r.path).join(', ') || 'none';
  ledger.check('requests in the first hidden minute', first.length <= 2, { detail: `${first.length} (limit 2): ${list(first)}` });
  ledger.check('requests in the other 59 minutes', rest.length === 0, { detail: `${rest.length} (limit 0): ${list(rest)}` });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);

  const back = await s.lastSeq();
  await s.setVisibility('visible');
  await s.waitForReplay({ after: back });
  const c = await s.finish();
  s.expectHealthy(c);
});

test('a visible tab left idle for an hour pauses replay and goes quiet', async ({ sq }, testInfo) => {
  knownGap(!SDK.v2, '1.x records an idle tab for as long as it stays open');
  test.setTimeout(120_000);
  const { s, page } = await openClock(sq);
  const from = await s.lastSeq();
  await simulate(page, 20);
  await sleep(1000);
  const during = await requestsSince(s, from);
  const segments = during.filter((r) => r.kind?.startsWith('segment'));
  const expired = await s.lastSeq();
  await simulate(page, 40);
  await sleep(1000);
  const late = await requestsSince(s, expired);
  // About 5 min of recording before the idle pause, then interim view updates until the
  // session expires at 15 min; 1.0.x sent about 190 replay requests an hour here.
  const ledger = new Ledger(`Idle hour with a ticking clock, SDK ${SDK.version}`);
  ledger.check('segments in the first 20 minutes', segments.length <= 16, { detail: `${segments.length} (limit 16)` });
  ledger.check('requests in the first 20 minutes', during.length <= 24, { detail: `${during.length} (limit 24)` });
  ledger.check('requests in the last 40 minutes', late.length === 0, { detail: `${late.length} (limit 0): ${late.map((r) => r.path).join(', ') || 'none'}` });
  ledger.print(testInfo);
  expect(ledger.failures).toEqual([]);

  const back = await s.lastSeq();
  await page.getByTestId('clock-button').click();
  await s.waitForReplay({ after: back });
  const c = await s.finish();
  s.expectHealthy(c);
});
