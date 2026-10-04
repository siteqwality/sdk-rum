import { defineConfig, devices } from '@playwright/test';
import { ORIGINS, PORTS } from './server/origins.js';

// Chromium by default; SQ_BROWSERS=chromium,firefox,webkit adds others (npx playwright install them first).
const browsers = (process.env.SQ_BROWSERS || 'chromium').split(',').map((b) => b.trim());
const DEVICES = { chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' };

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.js',
  globalSetup: './e2e/global-setup.js',
  // One mock intake and fixed ports: tests run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['./e2e/lib/gap-reporter.js'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    trace: 'retain-on-failure',
    // Every host but the fixture's fails to resolve, so nothing can reach production. *.sq.test
    // are subdomains of one site, for sessions shared through cookieDomain.
    launchOptions: { args: ['--host-resolver-rules=MAP *.sq.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] },
  },
  projects: browsers.map((name) => ({
    name,
    use: { ...devices[DEVICES[name]], ...(name === 'chromium' ? {} : { launchOptions: {} }) },
  })),
  webServer: {
    command: 'node server/index.js',
    url: `http://127.0.0.1:${PORTS.site}/healthz`,
    // Never reuse: a server left running may serve another SDK build.
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 20_000,
  },
  metadata: { site: ORIGINS.site },
});
