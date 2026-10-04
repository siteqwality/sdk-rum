import { defineConfig, devices } from '@playwright/test';

// Real-browser checks on the built CDN files; run `npm run build` first.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: 'list',
  timeout: 30_000,
  use: { ...devices['Desktop Chrome'], headless: true },
});
