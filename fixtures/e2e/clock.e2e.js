// A page that patches Date (constructor and Date.now) must not skew event times: every RUM event
// and replay event is stamped from a clock the page cannot patch, sane and in order.
import { test, expect, knownGap } from './lib/session.js';
import { SDK } from './lib/env.js';

test('a page that patches Date gets sane, monotonic event and replay times', async ({ sq }) => {
  knownGap(!SDK.v2, '1.x stamps events with the page Date; 2.0 uses a clock the page cannot patch');
  const s = await sq.start({ spec: { capture: 'replay' } });
  const started = Date.now();
  const page = await s.open('/mpa/patched-date.html');
  expect(await page.getByTestId('today').textContent()).toContain('2000');
  await s.waitForReplay();
  await page.getByTestId('date-input').fill('typed on a page living in 2000');
  await page.getByTestId('date-button').click();
  await page.getByTestId('date-error').click();
  await page.waitForTimeout(1500);
  const c = await s.finish();
  const ended = Date.now();
  s.expectHealthy(c);

  const sane = (t) => t >= started - 60_000 && t <= ended + 60_000;
  const batches = c.records.filter((r) => r.kind === 'batch_v2' && r.json?.events);
  expect(batches.length).toBeGreaterThan(0);
  for (const b of batches) {
    expect(sane(b.json.sent_at), `sent_at ${b.json.sent_at}`).toBe(true);
    for (const e of b.json.events) expect(sane(e.t), `${e.k} at ${new Date(e.t).toISOString()}`).toBe(true);
  }
  const views = c.batch('view_start');
  const ends = c.batch('view_end');
  for (const end of ends) {
    const start = views.find((v) => v.view_id === end.view_id);
    if (start) expect(end.t).toBeGreaterThanOrEqual(start.t);
  }
  expect(c.errors.some((e) => e.message?.includes('fx:patched-date'))).toBe(true);
  // The session id is a UUIDv7: its time is the real one too.
  const sid = [...c.sessionIds][0];
  const idTime = parseInt(sid.replace(/-/g, '').slice(0, 12), 16);
  expect(sane(idTime), `session id time ${new Date(idTime).toISOString()}`).toBe(true);

  expect(c.segments.length).toBeGreaterThan(0);
  for (const seg of c.segments) {
    const ts = seg.events.map((e) => e.timestamp);
    for (const t of ts) expect(sane(t), `replay event at ${new Date(t).toISOString()}`).toBe(true);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
  }
});
