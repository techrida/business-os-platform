import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The signed-in shell loads on every page. The root of @bos/contracts is a large bundle of zod schemas, so a
// client file that takes a value from it drags all of it into every route. Shell code takes constants and pure
// helpers from `@bos/contracts/constants` instead; a type-only import from the root is erased and is fine.

const SRC = join(__dirname, '..');
const SHELL = join(SRC, 'components', 'shell');

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = join(dirname(from), spec);
  else return null;
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) if (existsSync(base + ext)) return base + ext;
  return null;
}

interface Import {
  spec: string;
  typeOnly: boolean;
}

/** Static `import ... from 'x'` and `export ... from 'x'` statements. A statement is type-only when it is `import type`, or every named binding is `type`. */
function importsOf(source: string): Import[] {
  const out: Import[] = [];
  const re = /^(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(re)) {
    const clause = m[2] ?? '';
    let typeOnly = m[1] !== undefined;
    if (!typeOnly) {
      const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
      if (named !== null) {
        const names = (named[1] ?? '')
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
        typeOnly = names.length > 0 && names.every((n) => n.startsWith('type '));
      }
    }
    out.push({ spec: m[3] ?? '', typeOnly });
  }
  return out;
}

function shellRoots(): string[] {
  return readdirSync(SHELL)
    .filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n))
    .map((n) => join(SHELL, n));
}

/** Every non-test file the shell reaches, with the files that import the contracts root for a value. */
function offenders(): { file: string; spec: string }[] {
  const seen = new Set<string>();
  const bad: { file: string; spec: string }[] = [];
  const queue = shellRoots();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const imp of importsOf(readFileSync(file, 'utf8'))) {
      if (imp.spec === '@bos/contracts' && !imp.typeOnly) bad.push({ file, spec: imp.spec });
      const next = resolveLocal(file, imp.spec);
      if (next !== null && /\.tsx?$/.test(next) && !/\.test\.tsx?$/.test(next)) queue.push(next);
    }
  }
  return bad.map((b) => ({ ...b, file: b.file.slice(SRC.length + 1) }));
}

describe('shell imports of @bos/contracts', () => {
  it('walks the shell and the files it reaches', () => {
    expect(shellRoots().length).toBeGreaterThan(5);
  });

  it('takes no value from the contracts root', () => {
    expect(offenders()).toEqual([]);
  });

  it('classifies type-only and value imports', () => {
    expect(importsOf("import type { A } from '@bos/contracts';")[0]?.typeOnly).toBe(true);
    expect(importsOf("import { type A, type B } from '@bos/contracts';")[0]?.typeOnly).toBe(true);
    expect(importsOf("import { a, type B } from '@bos/contracts';")[0]?.typeOnly).toBe(false);
  });
});
