#!/usr/bin/env node
// Pins the sha256 of every migration file that is not pinned yet in packages/db/migrations-pinned.json.
// Run it when a migration has been merged (released): `node tools/pin-migrations.mjs`, then commit the manifest.
// It only ADDS entries. A changed released file is a bug to revert, never something to re-pin: migrate.ts refuses to
// run on any database whose ledger holds a hash that no file matches. Pass --check to list unpinned files only.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'db');
const manifestPath = join(root, 'migrations-pinned.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const files = readdirSync(join(root, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const added = [];
for (const file of files) {
  if (manifest[file] !== undefined) continue;
  // The same text and digest drizzle's readMigrationFiles records in the ledger.
  manifest[file] = createHash('sha256')
    .update(readFileSync(join(root, 'migrations', file)).toString())
    .digest('hex');
  added.push(file);
}
if (process.argv.includes('--check')) {
  console.log(added.length === 0 ? 'every migration is pinned' : `unpinned: ${added.join(', ')}`);
} else {
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(added.length === 0 ? 'nothing to pin' : `pinned: ${added.join(', ')}`);
}
