import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts'], // Playwright specs in tests/ run via `npm run pw`, not vitest
  },
});
