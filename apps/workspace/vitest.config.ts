import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript source through the `bos-source` condition for
// tsc. Vitest gets the same source through an explicit alias, so tests need no `dist` build.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // The subpath first: an alias matches by prefix, so the bare name would swallow it.
      '@bos/contracts/constants': source('../../packages/contracts/src/constants/index.ts'),
      '@bos/contracts': source('../../packages/contracts/src/index.ts'),
      '@bos/locale': source('../../packages/locale/src/index.ts'),
      '@bos/pdf-viewer': source('../../packages/pdf-viewer/src/index.ts'),
      '@': source('./src'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/test/vitest-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'next.config.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    // The gate shares one machine with other units; render-heavy files exceeded 5 s under load.
    testTimeout: 15_000,
  },
});
