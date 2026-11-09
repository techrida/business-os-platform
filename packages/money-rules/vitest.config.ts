import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// @bos/locale exports its TypeScript source through the `bos-source` condition for tsc.
// Vitest gets the same source through an explicit alias, so tests need no `dist` build.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bos/locale': source('../locale/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // fast-check properties run thousands of cases; a loaded gate machine needs more than 5 s.
    testTimeout: 30_000,
  },
});
