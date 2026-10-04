import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, snippet, sdkLoaded, hide, VERSION, REPLAY_ALL, REPLAY_ON_ERROR, ANALYZE_ALL } from './fixtures';

const HOST_GLOBALS = `<script>
  window.$ = function jQuery() {};
  window._ = { map: function () { return []; } };
  window.__hostJq = window.$;
  window.__hostLodash = window._;
  window.__before = Object.getOwnPropertyNames(window);
</script>`;

test.describe('CDN core loaded by the install snippet (classic script)', () => {
  test('adds only window.SiteQwalityRUM, fetches config without a preflight and sends a gzip v2 batch', async ({ page, intake }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const url = intake.page('classic', `<!doctype html><html><head>${HOST_GLOBALS}${snippet(intake)}</head><body><h1>Shop</h1></body></html>`);
    await page.goto(url);
    await sdkLoaded(page);

    const added = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & { __before: string[] };
      return Object.getOwnPropertyNames(window).filter((k) => !w.__before.includes(k) && !k.startsWith('__'));
    });
    expect(added).toEqual(['SiteQwalityRUM']);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).$ === (window as unknown as Record<string, unknown>).__hostJq)).toBe(true);
    await page.addScriptTag({ content: 'var t = 1; let e = 2; const n = 3; function r() {} window.__declared = true;' });
    expect(await page.evaluate(() => (window as unknown as { __declared?: boolean }).__declared)).toBe(true);
    expect(pageErrors).toEqual([]);

    await page.evaluate(() => {
      for (let i = 0; i < 40; i++) (window as unknown as { SiteQwalityRUM: { addAction(n: string): void } }).SiteQwalityRUM.addAction(`padding action ${i}`);
    });
    await hide(page);
    await expect.poll(() => intake.batches().length).toBeGreaterThan(0);
    const [batch] = intake.batches();
    expect(intake.received.find((r) => r.kind === 'batch')!.gzip).toBe(true);
    expect(batch.ctx.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(intake.events('view_start')[0]).toMatchObject({ loading_type: 'initial_load', navigation_type: 'navigate' });
    expect(intake.received.filter((r) => r.kind === 'config')).toHaveLength(1);
    expect(intake.received.filter((r) => r.kind === 'preflight' && r.path.includes('/config/'))).toEqual([]);
  });

  test('loads the replay chunk lazily beside the core and uploads replay', async ({ page, intake }) => {
    intake.config = REPLAY_ALL;
    const requested: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    const url = intake.page('replay', `<!doctype html><html><head>${snippet(intake)}</head><body><input type="email" value="jane@example.com"><p>Catalog</p></body></html>`);
    await page.goto(url);
    await sdkLoaded(page);
    await expect.poll(() => intake.segments().length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(requested).toContain(`/sdk/recorder-${VERSION}.min.js`);
    expect(requested.filter((p) => p.includes('gzip-')), 'the gzip fallback is only for browsers without CompressionStream').toEqual([]);
    const [segment] = intake.segments();
    await hide(page);
    await expect.poll(() => intake.events('status').some((s) => s.state === 'recording')).toBe(true);
    const ctx = intake.batches().at(-1)!.ctx;
    // Design 6.4: index fields in the query, a gzip JSON array of rrweb events as the body.
    expect(segment).toMatchObject({ s: ctx.session_id, w: ctx.window_id, p: ctx.page_load_id, q: 0, fs: true, fin: false, r: 'r_all', v: VERSION, gzip: true, contentType: 'application/octet-stream' });
    expect(segment.n).toBe(segment.events.length);
    expect(segment.ft).toBe(Math.min(...segment.events.map((e) => e.timestamp)));
    expect(segment.lt).toBe(Math.max(...segment.events.map((e) => e.timestamp)));
    expect(segment.events.map((e) => e.type).slice(0, 2)).toEqual([4, 2]);
    expect(JSON.stringify(segment.events)).not.toContain('jane@example.com');
    expect(ctx.sampling).toMatchObject({ replay: true, rule_id: 'r_all' });
  });

  test('without CompressionStream the gzip fallback loads beside the recorder', async ({ page, intake }) => {
    intake.config = REPLAY_ALL;
    const requested: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    await page.addInitScript(() => {
      delete (window as unknown as { CompressionStream?: unknown }).CompressionStream;
    });
    await page.goto(intake.page('no-cs', `<!doctype html><html><head>${snippet(intake)}</head><body><p>Old Safari</p></body></html>`));
    await sdkLoaded(page);
    await expect.poll(() => intake.segments().length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(requested).toContain(`/sdk/gzip-${VERSION}.min.js`);
    expect(intake.segments()[0]).toMatchObject({ gzip: true, contentType: 'application/octet-stream', q: 0, fs: true });
  });

  test('an errored-sessions rule buffers in memory and sends nothing until the error', async ({ page, intake }) => {
    intake.config = REPLAY_ON_ERROR;
    await page.goto(intake.page('ring', `<!doctype html><html><head>${snippet(intake)}</head><body><p id="t">0</p><button id="b">Go</button></body></html>`));
    await sdkLoaded(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { SiteQwalityRUM: { getStatus(): { recording: string } } }).SiteQwalityRUM.getStatus().recording)).toBe('buffering');
    const before = Date.now();
    for (let i = 1; i <= 5; i++) {
      await page.evaluate((n) => (document.getElementById('t')!.textContent = String(n)), i);
      await page.waitForTimeout(200);
    }
    expect(intake.segments(), 'nothing leaves the page before a rule matches').toHaveLength(0);
    await page.evaluate(() => setTimeout(() => {
      throw new Error('boom');
    }));
    await expect.poll(() => intake.segments().length, { timeout: 10_000 }).toBeGreaterThan(0);
    const [first] = intake.segments();
    expect(first).toMatchObject({ q: 0, fs: true, r: 'r_err' });
    expect(first.ft, 'the replay starts before the error, at page load').toBeLessThan(before);
    await hide(page);
    await expect.poll(() => intake.events('status').some((s) => s.state === 'recording')).toBe(true);
  });

  test('a buffering tab that never matches sends no replay, even when it closes', async ({ page, intake }) => {
    intake.config = REPLAY_ON_ERROR;
    await page.goto(intake.page('ring-close', `<!doctype html><html><head>${snippet(intake)}</head><body><p>Quiet</p></body></html>`));
    await sdkLoaded(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { SiteQwalityRUM: { getStatus(): { recording: string } } }).SiteQwalityRUM.getStatus().recording)).toBe('buffering');
    await hide(page);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => intake.events('view_end').some((e) => e.final === true)).toBe(true);
    expect(intake.segments()).toHaveLength(0);
  });

  test('two tabs of one session each record their own window', async ({ context, intake }) => {
    intake.config = REPLAY_ALL;
    const a = await context.newPage();
    await a.goto(intake.page('tab-a', `<!doctype html><html><head>${snippet(intake)}</head><body><p>Tab A</p></body></html>`));
    await sdkLoaded(a);
    const b = await context.newPage();
    await b.goto(intake.page('tab-b', `<!doctype html><html><head>${snippet(intake)}</head><body><p>Tab B</p></body></html>`));
    await sdkLoaded(b);
    await expect.poll(() => new Set(intake.segments().map((s) => s.w)).size, { timeout: 10_000 }).toBe(2);
    const segs = intake.segments();
    expect(new Set(segs.map((s) => s.s)).size, 'one session').toBe(1);
    for (const w of new Set(segs.map((s) => s.w))) {
      const mine = segs.filter((s) => s.w === w);
      expect(mine[0]).toMatchObject({ q: 0, fs: true });
      expect(new Set(mine.map((s) => s.p)).size).toBe(1);
    }
  });

  test('never downloads the replay chunk without a replay rule', async ({ page, intake }) => {
    const requested: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    await page.goto(intake.page('observe', `<!doctype html><html><head>${snippet(intake)}</head><body></body></html>`));
    await sdkLoaded(page);
    await page.waitForTimeout(500);
    expect(requested.filter((p) => p.includes('recorder-'))).toEqual([]);
  });

  test('captures errors raised before the SDK script arrives, with their own times', async ({ page, intake }) => {
    const url = intake.page(
      'early',
      `<!doctype html><html><head>${snippet(intake, '/sdk/sdk.min.js?delay=500')}
      <script>
        window.__thrownAt = Date.now();
        setTimeout(function () { throw new TypeError('early boom'); }, 0);
        Promise.reject(new Error('early reject'));
        window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }));
      </script></head><body></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);
    const thrownAt = await page.evaluate(() => (window as unknown as { __thrownAt: number }).__thrownAt);
    const loadedAt = await page.evaluate(() => Date.now());
    await hide(page);
    await expect.poll(() => intake.events('error').length).toBe(2);
    const errors = intake.events<{ error_type: string; message: string; handling: string; t: number }>('error');
    expect(errors.map((e) => [e.error_type, e.message, e.handling]).sort()).toEqual([
      ['Error', 'early reject', 'unhandledrejection'],
      ['TypeError', 'early boom', 'unhandled'],
    ]);
    for (const e of errors) {
      expect(e.t).toBeGreaterThanOrEqual(thrownAt - 5);
      expect(e.t).toBeLessThan(loadedAt - 300);
    }
  });

  test('the 1.0.x snippet still works', async ({ page, intake }) => {
    const url = intake.page(
      'old-snippet',
      `<!doctype html><html><head><script>
        (function(w,d,s){w.SiteQwalityRUM=w.SiteQwalityRUM||{_q:[]};
        ['init','setUser','addError','addAction'].forEach(function(m){
          w.SiteQwalityRUM[m]=function(){w.SiteQwalityRUM._q.push([m,arguments])}
        });var e=d.createElement(s);e.async=1;
        e.src='${intake.origin}/sdk/sdk.min.js';
        d.getElementsByTagName(s)[0].parentNode.insertBefore(e,d.getElementsByTagName(s)[0]);
        })(window,document,'script');
        SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_test',
          ingestBase: location.origin + '/rum', replayBase: location.origin + '/replay', configBase: location.origin + '/cdn' });
        SiteQwalityRUM.addError(new Error('queued by an old snippet'));
      </script></head><body></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);
    await hide(page);
    await expect.poll(() => intake.events('error').length).toBe(1);
    expect(intake.events('error')[0]).toMatchObject({ message: 'queued by an old snippet', handling: 'handled' });
  });

  test('a second copy of the script is a no-op', async ({ page, intake }) => {
    await page.goto(intake.page('twice', `<!doctype html><html><head>${snippet(intake)}</head><body></body></html>`));
    await sdkLoaded(page);
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__first = (window as unknown as Record<string, unknown>).SiteQwalityRUM;
    });
    await page.addScriptTag({ url: `${intake.origin}/sdk/sdk.min.js` });
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).SiteQwalityRUM === (window as unknown as Record<string, unknown>).__first)).toBe(true);
    await hide(page);
    await expect.poll(() => intake.events('view_start').length).toBeGreaterThan(0);
    expect(intake.events('view_start')).toHaveLength(1);
  });
});

test.describe('sessions in a real browser', () => {
  test('two tabs share one session through the cookie; a new tab gets its own window id', async ({ context, intake }) => {
    const url = intake.page('tabs', `<!doctype html><html><head>${snippet(intake)}</head><body></body></html>`);
    const a = await context.newPage();
    await a.goto(url);
    await sdkLoaded(a);
    const b = await context.newPage();
    await b.goto(url);
    await sdkLoaded(b);
    const status = (p: typeof a) => p.evaluate(() => (window as unknown as { SiteQwalityRUM: { getStatus(): { session_id: string; window_id: string } } }).SiteQwalityRUM.getStatus());
    const [sa, sb] = [await status(a), await status(b)];
    expect(sb.session_id).toBe(sa.session_id);
    expect(sb.window_id).not.toBe(sa.window_id);
  });

  test('closing the tab delivers the final view_end with keepalive', async ({ page, intake }) => {
    await page.goto(intake.page('close', `<!doctype html><html><head>${snippet(intake)}</head><body></body></html>`));
    await sdkLoaded(page);
    await page.waitForTimeout(300);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => intake.events('view_end').some((e) => e.final === true)).toBe(true);
  });
});

test.describe('CDN core loaded from another origin, as from the CDN', () => {
  test('imports the replay chunk cross-origin with the CDN CORS header', async ({ page, intake }) => {
    intake.config = REPLAY_ALL;
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    await page.goto(intake.page('cross-origin', `<!doctype html><html><head>${snippet(intake, `${intake.crossOrigin}/sdk/sdk.min.js`)}</head><body><p>Shop</p></body></html>`));
    await sdkLoaded(page);
    await expect.poll(() => intake.segments().length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(requested).toContain(`${intake.crossOrigin}/sdk/recorder-${VERSION}.min.js`);
  });

  test('without CORS the replay chunk fails quietly: one warning, no page error, RUM still flows', async ({ page, intake }) => {
    intake.config = REPLAY_ALL;
    const warnings: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(intake.page('no-cors', `<!doctype html><html><head>${snippet(intake, `${intake.crossOrigin}/sdk-nocors/sdk.min.js`)}</head><body></body></html>`));
    await sdkLoaded(page);
    await expect.poll(() => warnings.filter((w) => w.includes('Replay recorder failed to load')).length).toBe(1);
    await hide(page);
    await expect.poll(() => intake.events('view_start').length).toBeGreaterThan(0);
    expect(intake.segments()).toHaveLength(0);
    expect(intake.events('status').some((s) => s.reason === 'load_failed')).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('CDN core loaded as type="module"', () => {
  test('works, and finds the replay chunk at the CDN v2 path without currentScript', async ({ page, intake }) => {
    intake.config = REPLAY_ALL;
    const recorder = await readFile(join(import.meta.dirname, `../dist/cdn/recorder-${VERSION}.min.js`));
    let fetchedRecorder = '';
    await page.route('https://cdn.siteqwality.com/rum/v2/**', async (route) => {
      fetchedRecorder = route.request().url();
      await route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: recorder });
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(
      intake.page(
        'module',
        `<!doctype html><html><head>${HOST_GLOBALS}
      <script type="module" src="${intake.origin}/sdk/sdk.min.js"></script>
      <script type="module">
        SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_test',
          ingestBase: location.origin + '/rum', replayBase: location.origin + '/replay', configBase: location.origin + '/cdn' });
      </script></head><body><p>Module install</p></body></html>`,
      ),
    );
    await sdkLoaded(page);
    const added = await page.evaluate(() => {
      const w = window as unknown as { __before: string[] };
      return Object.getOwnPropertyNames(window).filter((k) => !w.__before.includes(k) && !k.startsWith('__'));
    });
    expect(added).toEqual(['SiteQwalityRUM']);
    await expect.poll(() => intake.segments().length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(fetchedRecorder).toBe(`https://cdn.siteqwality.com/rum/v2/recorder-${VERSION}.min.js`);
    expect(pageErrors).toEqual([]);
  });

  test('recorderUrl overrides where the replay chunk comes from', async ({ page, intake }) => {
    intake.config = REPLAY_ALL;
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    await page.goto(intake.page('recorder-url', `<!doctype html><html><head>${snippet(intake, '/sdk/sdk.min.js', `recorderUrl: '/sdk/recorder-${VERSION}.min.js?self-hosted=1',`)}</head><body></body></html>`));
    await expect.poll(() => intake.segments().length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(requested).toContain(`${intake.origin}/sdk/recorder-${VERSION}.min.js?self-hosted=1`);
  });
});

test.describe('page views and frustration in a real browser', () => {
  test('init before load: load timings on the initial view_end; route changes dedupe', async ({ page, intake }) => {
    const url = intake.page('timing', `<!doctype html><html><head>${snippet(intake)}</head><body><img src="/slow.png?delay=800" alt=""></body></html>`);
    await page.goto(url, { waitUntil: 'load' });
    await sdkLoaded(page);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      history.replaceState(null, '', location.pathname + '?utm_source=x');
      history.replaceState(null, '', location.pathname);
      history.pushState(null, '', '/page/timing/next');
    });
    await hide(page);
    await expect.poll(() => intake.events('view_end').length).toBeGreaterThanOrEqual(2);
    const views = intake.events('view_start');
    expect(views.map((v) => [v.loading_type, v.url])).toEqual([
      ['initial_load', url],
      ['route_change', `${intake.origin}/page/timing/next`],
    ]);
    const initialEnd = intake.events('view_end').filter((e) => e.view_id === views[0].view_id).at(-1)!;
    expect(initialEnd.load_event_ms as number).toBeGreaterThan(700);
    expect(initialEnd.dom_content_loaded_ms as number).toBeGreaterThan(0);
    expect(initialEnd.fcp_ms as number).toBeGreaterThan(0);
    expect(initialEnd.ttfb_ms as number).toBeGreaterThanOrEqual(0);
  });

  test('a hash router gets one view per route with hashRouting; anchors and tokens stay out', async ({ page, intake }) => {
    const url = intake.page('hash', `<!doctype html><html><head>${snippet(intake, '/sdk/sdk.min.js', 'hashRouting: true,')}</head><body><h2 id="reviews">Reviews</h2></body></html>`);
    await page.goto(url);
    await sdkLoaded(page);
    for (const hash of ['#/inbox', '#/inbox/42?token=secret', '#reviews', '#!/settings', '#access_token=abc', '#/access_token=secret&token_type=Bearer']) {
      await page.evaluate((h) => {
        location.hash = h;
      }, hash);
      await page.waitForTimeout(50);
    }
    await hide(page);
    await expect.poll(() => intake.events('view_start').length).toBeGreaterThanOrEqual(4);
    expect(intake.events<{ url: string }>('view_start').map((v) => v.url)).toEqual([url, `${url}#/inbox`, `${url}#/inbox/42`, `${url}#!/settings`]);
    expect(JSON.stringify(intake.received)).not.toContain('secret');
  });

  test('a dead button and a rage burst, with selectors and click counts', async ({ page, intake }) => {
    intake.config = ANALYZE_ALL;
    const url = intake.page(
      'clicks',
      `<!doctype html><html><head>${snippet(intake)}</head><body>
        <button id="dead" class="dead">Apply coupon</button>
        <button id="live" class="live">Next</button>
        <button id="menu" class="menu">Options</button>
        <script>
          document.getElementById('live').addEventListener('click', function (e) { e.currentTarget.classList.toggle('on'); });
          document.getElementById('menu').addEventListener('pointerdown', function (e) {
            e.currentTarget.insertAdjacentHTML('afterend', '<div role="menu">Open</div>');
          });
        </script>
      </body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);
    await page.waitForTimeout(300);
    await page.click('#dead');
    await page.waitForTimeout(1_200);
    for (let i = 0; i < 5; i++) await page.click('#live', { delay: 0 });
    await page.waitForTimeout(1_300);
    await page.click('#menu');
    await page.waitForTimeout(1_300);
    await hide(page);
    await expect.poll(() => intake.events('action').length).toBe(7);
    const actions = intake.events<{ name: string; selector: string; frustration?: string; click_count?: number; offset_pct?: number[] }>('action');
    expect(actions.find((a) => a.selector === '#dead')).toMatchObject({ name: 'Apply coupon', frustration: 'dead_click' });
    const rage = actions.filter((a) => a.frustration === 'rage_click');
    expect(rage).toHaveLength(1);
    expect(rage[0].click_count).toBeGreaterThanOrEqual(3);
    expect(actions.filter((a) => a.selector === '#live' && a.frustration === 'dead_click')).toHaveLength(0);
    expect(actions.find((a) => a.selector === '#menu')?.frustration).toBeUndefined();
    expect(actions[0].offset_pct).toHaveLength(2);
  });
});
