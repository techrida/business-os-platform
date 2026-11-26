import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Same as apps/workspace: workspace packages resolve to their TypeScript source, so tests need
// no `dist` build.
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
    include: ['src/**/*.test.{ts,tsx}', 'next.config.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
