import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript source through the `bos-source` condition for
// tsc. Vitest gets the same source through an explicit alias, so tests need no `dist` build.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bos/contracts': source('../../packages/contracts/src/index.ts'),
      '@bos/locale': source('../../packages/locale/src/index.ts'),
      '@bos/pdf-viewer': source('../../packages/pdf-viewer/src/index.ts'),
      '@': source('./src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
