import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Same plugin and aliases as vitest.config.ts: SWC for decorator metadata, and workspace
// packages read from source so no `dist` build is needed.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// End-to-end tests: the real AppModule, a real Postgres and Valkey (Testcontainers) and an
// in-process OIDC issuer. Needs Docker. Run with: pnpm --filter @bos/api test:e2e
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@bos/contracts': source('../../packages/contracts/src/index.ts'),
      // Before '@bos/db': an alias matches by prefix, so the longer name must come first.
      '@bos/db/testing': source('../../packages/db/src/testing/test-database.ts'),
      '@bos/db': source('../../packages/db/src/index.ts'),
      '@bos/locale': source('../../packages/locale/src/index.ts'),
      '@bos/money-rules': source('../../packages/money-rules/src/index.ts'),
      // The BFF contract test loads the workspace's real API clients, which import through the workspace's own `@/` alias.
      '@': source('../workspace/src'),
    },
  },
  test: {
    environment: 'node',
    // A database dropped under a lent-out connection must not fail the run (packages/db/src/testing/vitest-setup.ts).
    setupFiles: [source('../../packages/db/src/testing/vitest-setup.ts')],
    include: ['test/e2e/**/*.e2e.test.ts'],
    // Starts the containers once for the whole run and hands their addresses to the tests.
    // The shared Postgres first (it sets the environment the second one reads), then Valkey, Mailpit and the seed.
    globalSetup: [
      source('../../packages/db/src/testing/vitest-global-setup.ts'),
      'test/e2e/global-setup.ts',
    ],
    // One file at a time: every file boots the whole app against the same two containers, and
    // each mutates process.env, so running them side by side would only add flakiness.
    fileParallelism: false,
    // Booting Nest, discovering JWKS and the first cold query are slow on a busy machine.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});
