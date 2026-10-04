import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    // The built-bundle checks run after a build (test:bundle), browser checks under Playwright.
    exclude: [...configDefaults.exclude, 'tests/cdn-bundle.test.ts', 'e2e/**', 'fixtures/**'],
  },
});
