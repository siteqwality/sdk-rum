import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, snippet, sdkLoaded, hide, VERSION } from './fixtures';

const MATCH_ALL_REPLAY = {
  filters: [{ filter_type: 'custom', conditions: {}, capture_replay: true }],
  settings: { privacy: { mask_inputs: true, mask_text: false } },
};

const HOST_GLOBALS = `<script>
  window.$ = function jQuery() {};
  window._ = { map: function () { return []; } };
  window.__hostJq = window.$;
  window.__hostLodash = window._;
  window.__before = Object.getOwnPropertyNames(window);
</script>`;

test.describe('CDN core loaded by the install snippet (classic script)', () => {
  test('adds only window.SiteQwalityRUM and leaves host globals alone', async ({ page, intake }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const url = intake.page(
      'classic',
      `<!doctype html><html><head>${HOST_GLOBALS}${snippet(intake)}</head><body><h1>Shop</h1></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);

    const added = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & { __before: string[] };
      return Object.getOwnPropertyNames(window).filter(
        (k) => !w.__before.includes(k) && !k.startsWith('__'),
      );
    });
    expect(added).toEqual(['SiteQwalityRUM']);
    expect(
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return w.$ === w.__hostJq && w._ === w.__hostLodash;
      }),
    ).toBe(true);

    // A later host script may declare any short name the minifier might have used.
    await page.addScriptTag({ content: 'var t = 1; let e = 2; const n = 3; function r() {} window.__declared = true;' });
    expect(await page.evaluate(() => (window as unknown as { __declared?: boolean }).__declared)).toBe(true);
    expect(pageErrors).toEqual([]);

    await hide(page);
    await expect.poll(() => intake.of('measure').length).toBeGreaterThan(0);
    expect(intake.of('measure')[0]).toMatchObject({ type: 'view', loading_type: 'initial_load' });
  });

  test('loads the recorder lazily beside the core and uploads replay', async ({ page, intake }) => {
    intake.config = MATCH_ALL_REPLAY;
    const requested: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    const url = intake.page(
      'replay',
      `<!doctype html><html><head>${snippet(intake)}</head><body><input type="email" value="jane@example.com"><p>Catalog</p></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);

    await expect.poll(() => intake.of('segments').length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(requested).toContain(`/sdk/recorder-${VERSION}.min.js`);
    expect(requested.some((p) => /rrweb-/.test(p))).toBe(false);
    const [segment] = intake.of<{ segment_index: number; events: Array<{ type: number }> }>('segments');
    expect(segment.segment_index).toBe(0);
    expect(segment.events.map((e) => e.type).slice(0, 2)).toEqual([4, 2]);
    // Inputs are masked by default.
    expect(JSON.stringify(segment.events)).not.toContain('jane@example.com');
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
    await expect.poll(() => intake.of('errors').length).toBe(2);
    const errors = intake.of<{ error_message: string; error_source: string; timestamp: number }>('errors');
    expect(errors.map((e) => [e.error_message, e.error_source]).sort()).toEqual([
      ['Uncaught TypeError: early boom', 'source'],
      ['early reject', 'console'],
    ]);
    for (const e of errors) {
      expect(e.timestamp).toBeGreaterThanOrEqual(thrownAt - 5);
      expect(e.timestamp).toBeLessThan(loadedAt - 300);
    }
  });

  test('the 1.0.x snippet still works', async ({ page, intake }) => {
    const url = intake.page(
      'old-snippet',
      `<!doctype html><html><head><script>
        (function(w,d,s,c,t){w.SiteQwalityRUM=w.SiteQwalityRUM||{_q:[]};
        ['init','setUser','addError','addAction'].forEach(function(m){
          w.SiteQwalityRUM[m]=function(){w.SiteQwalityRUM._q.push([m,arguments])}
        });var e=d.createElement(s);e.async=1;
        e.src='${intake.origin}/sdk/sdk.min.js';
        d.getElementsByTagName(s)[0].parentNode.insertBefore(e,d.getElementsByTagName(s)[0]);
        })(window,document,'script');
        SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_test',
          ingestBase: location.origin + '/rum', replayBase: location.origin + '/replay' });
        SiteQwalityRUM.addError(new Error('queued by an old snippet'));
      </script></head><body></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);
    await hide(page);
    await expect.poll(() => intake.of('errors').length).toBe(1);
    expect(intake.of('errors')[0]).toMatchObject({ error_message: 'queued by an old snippet', error_source: 'custom' });
  });

  test('a second copy of the script is a no-op', async ({ page, intake }) => {
    const url = intake.page(
      'twice',
      `<!doctype html><html><head>${snippet(intake)}</head><body></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__first = w.SiteQwalityRUM;
    });
    await page.addScriptTag({ url: `${intake.origin}/sdk/sdk.min.js` });
    const same = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return w.SiteQwalityRUM === w.__first;
    });
    expect(same).toBe(true);
    await hide(page);
    await expect.poll(() => intake.of('measure').length).toBeGreaterThan(0);
    expect(intake.of('measure').filter((m) => m.type === 'view')).toHaveLength(1);
  });
});

test.describe('CDN core loaded from another origin, as from the CDN', () => {
  test('imports the recorder cross-origin with the CDN CORS header', async ({ page, intake }) => {
    intake.config = MATCH_ALL_REPLAY;
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    const url = intake.page(
      'cross-origin',
      `<!doctype html><html><head>${snippet(intake, `${intake.crossOrigin}/sdk/sdk.min.js`)}</head><body><p>Shop</p></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);
    await expect.poll(() => intake.of('segments').length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(requested).toContain(`${intake.crossOrigin}/sdk/recorder-${VERSION}.min.js`);
  });

  test('without CORS the recorder fails quietly: one warning, no page error, RUM still flows', async ({ page, intake }) => {
    intake.config = MATCH_ALL_REPLAY;
    const warnings: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const url = intake.page(
      'no-cors',
      `<!doctype html><html><head>${snippet(intake, `${intake.crossOrigin}/sdk-nocors/sdk.min.js`)}</head><body></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);
    await expect.poll(() => warnings.filter((w) => w.includes('session replay recorder')).length).toBe(1);
    await hide(page);
    await expect.poll(() => intake.of('measure').length).toBeGreaterThan(0);
    expect(intake.of('segments')).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('CDN core loaded as type="module"', () => {
  test('works, and finds the recorder at the CDN path without currentScript', async ({ page, intake }) => {
    intake.config = MATCH_ALL_REPLAY;
    const recorder = await readFile(join(import.meta.dirname, `../dist/cdn/recorder-${VERSION}.min.js`));
    let fetchedRecorder = '';
    await page.route('https://cdn.siteqwality.com/rum/v1/**', async (route) => {
      fetchedRecorder = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: recorder,
      });
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const url = intake.page(
      'module',
      `<!doctype html><html><head>${HOST_GLOBALS}
      <script type="module" src="${intake.origin}/sdk/sdk.min.js"></script>
      <script type="module">
        SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_test',
          ingestBase: location.origin + '/rum', replayBase: location.origin + '/replay' });
      </script></head><body><p>Module install</p></body></html>`,
    );
    await page.goto(url);
    await sdkLoaded(page);
    const added = await page.evaluate(() => {
      const w = window as unknown as { __before: string[] };
      return Object.getOwnPropertyNames(window).filter((k) => !w.__before.includes(k) && !k.startsWith('__'));
    });
    expect(added).toEqual(['SiteQwalityRUM']);
    await expect.poll(() => intake.of('segments').length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(fetchedRecorder).toBe(`https://cdn.siteqwality.com/rum/v1/recorder-${VERSION}.min.js`);
    expect(pageErrors).toEqual([]);
  });

  test('recorderUrl overrides where the recorder comes from', async ({ page, intake }) => {
    intake.config = MATCH_ALL_REPLAY;
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    const url = intake.page(
      'recorder-url',
      `<!doctype html><html><head>${snippet(intake, '/sdk/sdk.min.js', `recorderUrl: '/sdk/recorder-${VERSION}.min.js?self-hosted=1',`)}</head><body></body></html>`,
    );
    await page.goto(url);
    await expect.poll(() => intake.of('segments').length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(requested).toContain(`${intake.origin}/sdk/recorder-${VERSION}.min.js?self-hosted=1`);
  });
});

test.describe('page views and frustration in a real browser', () => {
  test('init before load: a view without timings, then one timing vital; route changes dedupe', async ({ page, intake }) => {
    const url = intake.page(
      'timing',
      `<!doctype html><html><head>${snippet(intake)}</head>
      <body><img src="/slow.png?delay=800" alt=""></body></html>`,
    );
    await page.goto(url, { waitUntil: 'load' });
    await sdkLoaded(page);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      history.replaceState(null, '', location.pathname + '?utm_source=x');
      history.replaceState(null, '', location.pathname);
      history.pushState(null, '', '/page/timing/next');
    });
    await hide(page);
    await expect.poll(() => intake.of('measure').length).toBeGreaterThanOrEqual(3);

    const measures = intake.of<Record<string, unknown>>('measure');
    const views = measures.filter((m) => m.type === 'view');
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ loading_type: 'initial_load' });
    expect(views[0]).not.toHaveProperty('load_time_ms');
    expect(views[1]).toMatchObject({ loading_type: 'route_change', url: `${intake.origin}/page/timing/next` });
    expect(views[1]).not.toHaveProperty('load_time_ms');

    const timing = measures.filter((m) => m.type === 'vital' && m.loading_type === 'initial_load');
    expect(timing).toHaveLength(1);
    expect(timing[0].view_id).toBe(views[0].view_id);
    expect(timing[0].load_time_ms as number).toBeGreaterThan(700);
    expect(timing[0].dom_ready_ms as number).toBeGreaterThan(0);
    expect(timing[0].dom_ready_ms as number).toBeLessThanOrEqual(timing[0].load_time_ms as number);
  });

  test('a hash router gets one view per route; anchors and tokens stay out', async ({ page, intake }) => {
    const url = intake.page('hash', `<!doctype html><html><head>${snippet(intake)}</head><body><h2 id="reviews">Reviews</h2></body></html>`);
    await page.goto(url);
    await sdkLoaded(page);
    for (const hash of ['#/inbox', '#/inbox/42?token=secret', '#reviews', '#!/settings', '#access_token=abc']) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(50);
    }
    await hide(page);
    await expect.poll(() => intake.of('measure').filter((m) => m.type === 'view').length).toBeGreaterThanOrEqual(4);
    expect(intake.of<{ type: string; url: string }>('measure').filter((m) => m.type === 'view').map((m) => m.url)).toEqual([
      url,
      `${url}#/inbox`,
      `${url}#/inbox/42`,
      `${url}#!/settings`,
    ]);
    expect(JSON.stringify(intake.received)).not.toContain('secret');
  });

  test('init after load: the view carries its timings', async ({ page, intake }) => {
    const url = intake.page(
      'loaded',
      `<!doctype html><html><head></head><body><script>
        window.addEventListener('load', function () { setTimeout(function () {
          var s = document.createElement('script'); s.textContent = ${JSON.stringify(snippet(intake).replace(/<\/?script>/g, ''))};
          document.head.appendChild(s);
        }, 50); });
      </script></body></html>`,
    );
    await page.goto(url, { waitUntil: 'load' });
    await sdkLoaded(page);
    await hide(page);
    await expect.poll(() => intake.of('measure').length).toBeGreaterThan(0);
    const [view] = intake.of<Record<string, unknown>>('measure');
    expect(view).toMatchObject({ type: 'view', loading_type: 'initial_load' });
    expect(view.load_time_ms as number).toBeGreaterThan(0);
  });

  test('a dead button and a rage burst', async ({ page, intake }) => {
    intake.config = { filters: [{ filter_type: 'custom', conditions: {}, capture_replay: false }], settings: { privacy: { mask_inputs: true, mask_text: false } } };
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
    await page.waitForTimeout(200);
    await page.click('#dead');
    // Any DOM change counts as a reaction to every pending click, so the burst waits.
    await page.waitForTimeout(1_200);
    for (let i = 0; i < 5; i++) await page.click('#live', { delay: 0 });
    await page.waitForTimeout(1_300);
    // Opens on pointerdown, like Radix menus: the click itself changes nothing.
    await page.click('#menu');
    await page.waitForTimeout(1_300);
    await hide(page);
    await expect.poll(() => intake.of('events').filter((e) => e.type === 'action').length).toBe(7);
    const actions = intake.of<{ type: string; action_target: string; frustration?: string }>('events').filter((e) => e.type === 'action');
    expect(actions.find((a) => a.action_target.startsWith('#dead'))?.frustration).toBe('dead_click');
    expect(actions.filter((a) => a.frustration === 'rage_click')).toHaveLength(1);
    expect(actions.filter((a) => a.action_target === '#live' && a.frustration === 'dead_click')).toHaveLength(0);
    expect(actions.find((a) => a.action_target === '#menu')?.frustration).toBeUndefined();
  });
});
