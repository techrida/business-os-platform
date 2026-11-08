import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Testcontainers tests start a Postgres container, which is slow on a cold pull.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
