// The migration journal is the runner's only list of what exists and in what order. Phase branches append to it
// in parallel, so it drifts in ways the runner never reports: two entries sharing an idx, a tag without its file,
// a file nobody listed (it is silently never applied), or a `when` older than the entry before it.
// No database needed: this reads meta/_journal.json and the folder. Run with:
//   pnpm --filter @bos/db exec vitest run src/migration-journal.test.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER } from './migrate.js';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
) as { entries: JournalEntry[] };
const entries = journal.entries;

/** Values that occur more than once, each named once. */
const repeated = <T>(values: readonly T[]): T[] =>
  [...new Set(values.filter((value, i) => values.indexOf(value) !== i))];

describe('migrations/meta/_journal.json', () => {
  it('gives every entry its own idx', () => {
    expect(repeated(entries.map((entry) => entry.idx))).toEqual([]);
  });

  it('gives every entry its own tag', () => {
    expect(repeated(entries.map((entry) => entry.tag))).toEqual([]);
  });

  it('lists exactly the SQL files in the folder', () => {
    const files = readdirSync(MIGRATIONS_FOLDER)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length))
      .sort();
    expect([...entries.map((entry) => entry.tag)].sort()).toEqual(files);
  });

  it('never goes back in time: `when` is non-decreasing in the order the runner applies', () => {
    // Equal values are allowed (two 0037 files share one); an older one would mean an entry was inserted out of
    // place.
    const outOfOrder = entries
      .slice(1)
      .filter((entry, i) => entry.when < (entries[i]?.when ?? 0))
      .map((entry) => entry.tag);
    expect(outOfOrder).toEqual([]);
  });
});
