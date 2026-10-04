import { defineConfig } from 'vitest/config';

// Checks on the built CDN files; run `npm run build` first.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/cdn-bundle.test.ts'],
  },
});
