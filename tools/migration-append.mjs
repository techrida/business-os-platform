#!/usr/bin/env node
// Appends the journal entry of a new migration file to packages/db/migrations/meta/_journal.json.
//
//   node tools/migration-append.mjs packages/db/migrations/0140_my_change.sql
//   node tools/migration-append.mjs 0140_my_change.sql --dry-run
//
// The entry gets the next `idx` (highest idx + 1) and a `when` one above the highest `when` in the journal, so
// `when` only ever grows, whatever order units add their migrations in. Run it AFTER merging origin/p4-main:
// it reads the journal as it is then, and the rest of the file is left byte for byte as it was.
// It refuses a file that is not in packages/db/migrations, a name that is not `<NNNN>_<name>.sql`, a tag that
// is already journaled, and an empty file.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'packages/db/migrations');
const journalPath = join(migrationsDir, 'meta/_journal.json');

function fail(message) {
  console.error(`migration-append: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--dry-run');
if (unknown.length > 0) fail(`unknown option ${unknown.join(' ')}; the only option is --dry-run`);
const positional = args.filter((arg) => !arg.startsWith('--'));
if (positional.length !== 1) fail('usage: node tools/migration-append.mjs <file.sql> [--dry-run]');

const given = positional[0];
const candidates = [resolve(given), join(migrationsDir, basename(given))];
const sqlPath = candidates.find((path) => existsSync(path) && statSync(path).isFile());
if (sqlPath === undefined) fail(`no such file: ${given}`);
if (dirname(sqlPath) !== migrationsDir) fail(`${sqlPath} is not inside packages/db/migrations`);

const file = basename(sqlPath);
if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(file))
  fail(`${file} must be named <NNNN>_<snake_case_name>.sql`);
if (statSync(sqlPath).size === 0) fail(`${file} is empty`);
const tag = file.slice(0, -'.sql'.length);

const raw = readFileSync(journalPath, 'utf8');
const journal = JSON.parse(raw);
if (!Array.isArray(journal.entries)) fail('the journal has no entries array');
if (journal.entries.some((entry) => entry.tag === tag)) fail(`${tag} is already in the journal`);

const nextIdx = journal.entries.reduce((max, entry) => Math.max(max, entry.idx), -1) + 1;
const nextWhen = journal.entries.reduce((max, entry) => Math.max(max, entry.when), 0) + 1;
const last = journal.entries.at(-1);
const entry = {
  idx: nextIdx,
  version: last?.version ?? journal.version ?? '7',
  when: nextWhen,
  tag,
  breakpoints: last?.breakpoints ?? true,
};

// Same formatting as drizzle-kit and the existing file: 2 spaces and a final newline.
const reformatted = `${JSON.stringify(journal, null, 2)}\n`;
if (reformatted !== raw) fail('the journal is not in the standard 2-space format; fix it first');
journal.entries.push(entry);

if (dryRun) {
  console.log(`migration-append: would add ${JSON.stringify(entry)}`);
} else {
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  console.log(`migration-append: added idx ${entry.idx}, when ${entry.when}, tag ${tag}`);
}
