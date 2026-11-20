import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// F1-Q27 (Kuu, 2026-11-20): a quotation gets Cancel only; Recall will not be built. No screen in the
// workspace or the portal may promise to recall, or pull back, a submitted quotation.
const APPS = path.resolve(__dirname, '../../../../..');
const ROOTS = [path.join(APPS, 'workspace/src'), path.join(APPS, 'portal/src')];
const PROMISE = /\brecall(ed|ing|s)?\b|\bpull (it )?back\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|mdx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('quotation copy (F1-Q27: Cancel only)', () => {
  it('no workspace or portal screen promises a Recall', () => {
    const offenders = ROOTS.flatMap(sourceFiles).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${path.relative(APPS, file)}:${i + 1}` }))
        .filter(({ line }) => PROMISE.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
