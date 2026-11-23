import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript source through the `bos-source` condition for
// tsc. Vitest gets the same source through explicit aliases, so tests need no `dist` build.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // SWC emits decorator metadata (esbuild does not), which Nest dependency injection needs.
  // unplugin-swc reads experimentalDecorators and emitDecoratorMetadata from tsconfig.json.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      // Before '@bos/db': an alias matches by prefix, so the longer name must come first.
      '@bos/db/testing': source('../../packages/db/src/testing/test-database.ts'),
      '@bos/contracts': source('../../packages/contracts/src/index.ts'),
      '@bos/db': source('../../packages/db/src/index.ts'),
      '@bos/locale': source('../../packages/locale/src/index.ts'),
      '@bos/money-rules': source('../../packages/money-rules/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    // A database dropped under a lent-out connection must not fail the run (packages/db/src/testing/vitest-setup.ts).
    setupFiles: [source('../../packages/db/src/testing/vitest-setup.ts')],
    include: ['src/**/*.test.ts'],
    // One Postgres for the whole run, migrated once; every integration test copies it
    // (packages/db/src/testing/test-database.ts).
    globalSetup: [source('../../packages/db/src/testing/vitest-global-setup.ts')],
    // The gate machine has 31 GB and is shared with other sessions: a fixed cap beats one worker per core.
    maxWorkers: 4,
    // Testcontainers teardown (pool.end + container.stop) can take > 10 s on a loaded gate machine.
    hookTimeout: 60_000,
  },
});
