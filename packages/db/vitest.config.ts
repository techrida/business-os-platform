import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One Postgres for the whole run, migrated once; every test file copies it (src/testing/test-database.ts).
    globalSetup: [fileURLToPath(new URL('src/testing/vitest-global-setup.ts', import.meta.url))],
    // Each worker holds its own Node heap and a few Postgres connections. The gate machine has 31 GB and
    // is shared with other sessions, so a fixed cap beats "one worker per core".
    setupFiles: [fileURLToPath(new URL('src/testing/vitest-setup.ts', import.meta.url))],
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
