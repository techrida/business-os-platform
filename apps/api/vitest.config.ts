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
      '@bos/contracts': source('../../packages/contracts/src/index.ts'),
      '@bos/db': source('../../packages/db/src/index.ts'),
      '@bos/locale': source('../../packages/locale/src/index.ts'),
      '@bos/money-rules': source('../../packages/money-rules/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Testcontainers teardown (pool.end + container.stop) can take > 10 s on a loaded gate machine.
    hookTimeout: 60_000,
  },
});
