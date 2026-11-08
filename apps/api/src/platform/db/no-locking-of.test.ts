import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Guards against drizzle's `.for('update' | 'share' | 'no key update' | 'key share', { of: table })`. Drizzle
// renders it as FOR UPDATE OF "app"."table" (the schema-qualified name), and Postgres refuses a schema-qualified
// name there, so the query fails at run time, and a fake-store unit test never sees it. If this fails, lock the
// row in its own single-table select (`.for('share')` without `of`) and run the joined read without a lock.

const SELF = resolve(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DB_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));

/**
 * `.for(<anything>, { of` with whitespace and line breaks allowed anywhere (prettier splits long chains). Any
 * first argument counts: a lock mode held in a variable is the same bug.
 */
const LOCKING_OF = /\.for\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`|[\w.]+)\s*,\s*\{\s*of\b/g;

function isTest(name: string): boolean {
  return /\.(test|spec)\.ts$/.test(name);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !isTest(name))
    .map((name) => resolve(join(dir, name)))
    .filter((file) => file !== SELF);
}

/** `file:line` of every match, the line being the one the `.for(` starts on. */
function findLockingOf(files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(LOCKING_OF)) {
      const line = text.slice(0, match.index).split('\n').length;
      hits.push(`${relative(SRC_DIR, file).replaceAll('\\', '/')}:${line}`);
    }
  }
  return hits;
}

describe('no `.for(lock, { of })` row locking', () => {
  const files = sourceFiles(SRC_DIR);

  it('scans the real source tree, tests excluded', () => {
    // A wrong root would scan nothing and pass. Make sure files that take row locks are in the scan.
    expect(files).toContain(join(SRC_DIR, 'modules/quotations/expiry/quotation-expiry.sweeper.ts'));
    expect(files).toContain(join(DB_DIR, 'tx.ts'));
    expect(files.some((file) => isTest(file))).toBe(false);
  });

  it('has no schema-qualified lock target (FOR ... OF) in apps/api/src', () => {
    expect(findLockingOf(files)).toEqual([]);
  });

  it('would catch an offender (the pattern is not dead)', () => {
    const samples = [
      ".for('update', { of: quotationVersions })",
      '.for("share", { of: quotationVersions })',
      ".for('no key update', {of: a})",
      ".for('key share', { of: [a, b] })",
      '.for(lock, { of: quotationVersions })',
      ".for(\n  'share',\n  { of: quotationVersions },\n)",
    ];
    for (const sample of samples) {
      expect(sample.match(LOCKING_OF)).not.toBeNull();
    }
    const fine = [".for('update')", ".for('share', { noWait: true })", '.for(lock.lock)'];
    for (const sample of fine) {
      expect(sample.match(LOCKING_OF)).toBeNull();
    }
  });
});
