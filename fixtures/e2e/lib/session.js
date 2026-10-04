// A browser context wired to the fixture: its own app and token on the mock, the SDK under
// test, and guards for traffic leaving the fixture and for errors thrown by the SDK.
import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { ORIGINS } from '../../server/origins.js';
import { LOADER, SDK_PATH, STRICT } from './env.js';
import { mock, poll } from './mock.js';
import { Captures } from './captures.js';

const ALLOWED = [...Object.values(ORIGINS), 'data:', 'blob:', 'about:'];
const allowed = (url) => ALLOWED.some((prefix) => url.startsWith(prefix));

export class Session {
  // spec: the app's capture and privacy settings (server/app-config.js).
  // fixture: overrides for boot.js, such as { sdk: 'off' } or extra init options.
  static async start(browser, { spec = {}, fixture = {}, context = {} } = {}) {
    const s = new Session();
    s.token = `fx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    s.applicationId = randomUUID();
    s.spec = spec;
    s.egress = [];
    s.pageErrors = [];
    s.consoleMessages = [];
    await mock.register(s.token, s.applicationId, spec);
    s.context = await browser.newContext(context);
    await s.context.addInitScript((cfg) => {
      window.__SQ_FIXTURE__ = cfg;
    }, { clientToken: s.token, applicationId: s.applicationId, loader: LOADER, sdkPath: SDK_PATH, ...fixture });
    s.context.on('request', (req) => {
      if (!allowed(req.url())) s.egress.push(req.url());
    });
    s.context.on('page', (page) => s.watch(page));
    s.page = await s.context.newPage();
    return s;
  }

  watch(page) {
    page.on('pageerror', (err) => this.pageErrors.push({ message: err.message, stack: err.stack || '' }));
    page.on('console', (msg) => this.consoleMessages.push({ type: msg.type(), text: msg.text() }));
  }

  async open(path, { page = this.page, sdk = true } = {}) {
    await page.goto(ORIGINS.site + path);
    if (sdk) await this.waitForSdk(page);
    return page;
  }

  async newPage() {
    return this.context.newPage();
  }

  async waitForSdk(page = this.page) {
    const state = await page.waitForFunction(
      () => {
        const s = window.fixture?.sdk?.state;
        return s && s !== 'loading' ? s : null;
      },
      null,
      { timeout: 10000 },
    );
    const value = await state.jsonValue();
    const expected = (await page.evaluate(() => window.fixture.config.sdk)) === 'off' ? 'off' : 'loaded';
    if (value !== expected) throw new Error(`SDK script state is ${value}, expected ${expected}`);
  }

  async summary() {
    return mock.summary(this.token);
  }

  async waitForConfig() {
    return poll(async () => (await this.summary()).some((r) => r.kind === 'config_v1' || r.kind === 'config_v2'), {
      what: 'the SDK to fetch its config',
    });
  }

  // Resolves once a segment holding a full snapshot has arrived.
  async waitForReplay({ timeout = 15000, after = 0 } = {}) {
    return poll(
      async () => (await this.summary()).find((r) => r.segment?.fullSnapshots > 0 && r.seq > after),
      { timeout, what: 'a replay segment with a full snapshot' },
    );
  }

  async lastSeq() {
    const all = await this.summary();
    return all.length ? all[all.length - 1].seq : 0;
  }

  // Simulated: headless pages never become hidden on their own.
  async setVisibility(state, page = this.page) {
    await page.evaluate((s) => window.fixture.setVisibility(s), state);
  }

  // Hides every page (a tab switch, so open segments go out while the page lives), closes them
  // as a tab close would (pagehide), then waits for the SDK to go quiet. flush: false skips the hide.
  async finish({ quietMs = 1200, flush = true } = {}) {
    if (flush) {
      for (const page of this.context.pages()) await this.setVisibility('hidden', page).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
    for (const page of this.context.pages()) {
      const closed = page.waitForEvent('close');
      await page.close({ runBeforeUnload: true });
      await closed;
    }
    await new Promise((r) => setTimeout(r, 300));
    await mock.quiet(this.token, quietMs);
    this.captures = new Captures(await mock.records(this.token));
    return this.captures;
  }

  async capturesNow() {
    return new Captures(await mock.records(this.token));
  }

  // Errors thrown by SDK code into the page (as opposed to the errors the fixture raises).
  get sdkPageErrors() {
    return this.pageErrors.filter(
      (e) => e.stack.includes(ORIGINS.cdn) || /SiteQwality|rrweb|recorder-/.test(e.message),
    );
  }

  // The baseline every test asserts: nothing left the fixture, every payload was well formed,
  // the mock accepted every request, and the SDK threw nothing into the page.
  expectHealthy(captures = this.captures, { allowStatuses = [] } = {}) {
    expect.soft(this.egress, 'requests to hosts outside the fixture').toEqual([]);
    expect.soft(captures.problems, 'malformed SDK payloads').toEqual([]);
    const rejected = captures.rejected.filter((r) => !allowStatuses.includes(r.status));
    expect.soft(rejected.map((r) => `${r.method} ${r.path} -> ${r.status}`), 'requests the intake refused').toEqual([]);
    expect.soft(this.sdkPageErrors, 'errors thrown by the SDK into the page').toEqual([]);
  }

  async dispose() {
    await this.context.close().catch(() => {});
  }
}

export const test = base.extend({
  // Fresh mock records for every test; apps stay registered.
  resetMock: [
    async ({}, use) => {
      await mock.reset();
      await use();
    },
    { auto: true },
  ],
  sq: async ({ browser }, use) => {
    const sessions = [];
    await use({
      start: async (options) => {
        const s = await Session.start(browser, options);
        sessions.push(s);
        return s;
      },
    });
    for (const s of sessions) await s.dispose();
  },
});

// Marks a test as a known shortfall of this SDK version: it must fail, and passing flags the fix.
export function knownGap(condition, reason) {
  base.fail(condition && !STRICT, reason);
  if (condition) base.info().annotations.push({ type: 'known gap', description: reason });
}

export { expect };
