// Applies the SQL files in packages/db/migrations, in the order of migrations/meta/_journal.json.
//
//   node packages/db/dist/migrate.js        (the `migrate` service in compose; reads DATABASE_MIGRATE_URL)
//
// Safe to run any number of times: Drizzle records what it applied in drizzle.__drizzle_migrations and only
// applies files that are newer than the last recorded one.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { z } from 'zod';

import { createDb } from './client.js';

/**
 * `../migrations` is correct from both src/migrate.ts and dist/migrate.js, because src and dist are
 * siblings inside packages/db. That is why the compose `migrate` service can run the built file.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Connects as the given role (it must be able to create schemas: bos_owner) and applies pending migrations. */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool, close } = createDb(connectionString, { max: 1 });
  try {
    const history = await pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS table_name",
    );
    if (history.rows[0]?.table_name !== null) {
      const { rows } = await pool.query<{ hash: string; created_at: string | null }>(
        'SELECT hash, created_at FROM drizzle.__drizzle_migrations',
      );
      const newest = Math.max(...rows.map((row) => Number(row.created_at)));
      const hashes = new Set(rows.map((row) => row.hash));
      const timestamps = new Set(rows.map((row) => Number(row.created_at)));
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
      ) as { entries: { when: number; tag: string }[] };
      const tags = new Map(journal.entries.map((entry) => [entry.when, entry.tag]));
      // Drizzle only applies files newer than the last recorded timestamp. Detect older gaps before it
      // can silently skip them when the separately-pushed P3 and P4 histories converge.
      const missing = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).filter(
        (file) =>
          file.folderMillis < newest &&
          !hashes.has(file.hash) &&
          !timestamps.has(file.folderMillis),
      );
      if (missing.length > 0) {
        throw new Error(
          `Migration history is missing earlier migrations: ${missing.map((file) => tags.get(file.folderMillis)).join(', ')}; apply them in order before running migrations again`,
        );
      }
    }
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const env = z.object({ DATABASE_MIGRATE_URL: z.string().min(1) }).safeParse(process.env);
  if (!env.success) {
    // Only the variable name is printed; the value would hold a password.
    console.error(JSON.stringify({ level: 'error', msg: 'DATABASE_MIGRATE_URL is not set' }));
    process.exitCode = 1;
    return;
  }
  try {
    await runMigrations(env.data.DATABASE_MIGRATE_URL);
    console.log(JSON.stringify({ level: 'info', msg: 'migrations applied' }));
  } catch (error) {
    // Print the message only. pg errors can echo connection details, so no stack and no error object.
    const reason = error instanceof Error ? error.message : 'unknown error';
    console.error(JSON.stringify({ level: 'error', msg: 'migration failed', reason }));
    process.exitCode = 1;
  }
}

/** True when this file is the program being run (node migrate.js), false when it is imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main();
}
