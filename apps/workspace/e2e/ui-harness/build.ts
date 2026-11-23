import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'vite';

const here = __dirname;
const src = path.resolve(here, '../../src');
const pkg = (name: string) => path.resolve(here, `../../../../packages/${name}/src/index.ts`);

/** Bundles the harness page with the app's real components and CSS into a temp directory. */
export async function buildHarness(): Promise<string> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'bos-ui-harness-'));
  await build({
    root: here,
    logLevel: 'error',
    configFile: false,
    base: './',
    resolve: {
      alias: [
        { find: /^next\/link$/, replacement: path.resolve(here, 'next-link-stub.tsx') },
        { find: /^@bos\/contracts$/, replacement: pkg('contracts') },
        { find: /^@bos\/locale$/, replacement: pkg('locale') },
        { find: /^@bos\/pdf-viewer$/, replacement: pkg('pdf-viewer') },
        { find: /^@\//, replacement: `${src}/` },
      ],
    },
    esbuild: { jsx: 'automatic' },
    build: { outDir, emptyOutDir: true, minify: false },
  });
  return outDir;
}
