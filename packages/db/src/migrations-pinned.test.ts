// A released migration file must never change. migrate.ts hashes every file, and refuses to run on a database whose
// ledger (drizzle.__drizzle_migrations) holds a hash that no file matches ("Migration ledger contains an unknown
// applied SQL hash"), so even a comment edit in an applied file breaks every existing database (bos-testrun, any
// deploy) while a fresh CI database migrates fine.
//
// packages/db/migrations-pinned.json holds the sha256 of every released file, computed the way drizzle records it.
// This test fails when a pinned file is edited, renamed or deleted. A file that is not pinned yet (a migration still
// on its way to p4-main) is allowed, so parallel branches never conflict on the manifest. After a migration is merged,
// run `node tools/pin-migrations.mjs` and commit the manifest. It adds entries only; never re-pin a changed file,
// revert it (`git checkout origin/p4-main -- packages/db/migrations/<file>`) and put any note in a code comment.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinned = JSON.parse(readFileSync(join(root, 'migrations-pinned.json'), 'utf8')) as Record<
  string,
  string
>;

describe('released migrations are immutable', () => {
  it('pins a non-empty manifest', () => {
    expect(Object.keys(pinned).length).toBeGreaterThan(100);
  });

  it.each(Object.entries(pinned))('%s still has its pinned hash', (file, hash) => {
    const path = join(root, 'migrations', file);
    expect(existsSync(path), `${file} was deleted or renamed after release`).toBe(true);
    const actual = createHash('sha256').update(readFileSync(path).toString()).digest('hex');
    expect(actual, `${file} was edited after release: revert it byte for byte`).toBe(hash);
  });
});
