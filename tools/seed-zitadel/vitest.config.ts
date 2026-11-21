import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript source through the `bos-source` condition for
// tsc. Vitest gets the same source through explicit aliases, so tests need no `dist` build.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bos/db/testing': source('../../packages/db/src/testing/test-database.ts'),
      '@bos/contracts': source('../../packages/contracts/src/index.ts'),
      '@bos/db': source('../../packages/db/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: [source('../../packages/db/src/testing/vitest-global-setup.ts')],
    maxWorkers: 2,
  },
});
