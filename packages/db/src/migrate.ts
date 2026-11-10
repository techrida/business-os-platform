// Applies the SQL files in packages/db/migrations, in the order of migrations/meta/_journal.json.
//
//   node packages/db/dist/migrate.js        (the `migrate` service in compose; reads DATABASE_MIGRATE_URL)
//
// Safe to run any number of times: Drizzle records what it applied in drizzle.__drizzle_migrations and only
// applies files whose content hashes are not recorded, including older phase additions.
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { z } from 'zod';

import { createDb } from './client.js';

/**
 * `../migrations` is correct from both src/migrate.ts and dist/migrate.js, because src and dist are
 * siblings inside packages/db. That is why the compose `migrate` service can run the built file.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Connects as the given role (it must be able to create schemas: bos_owner) and applies pending migrations. */
export async function runMigrations(
  connectionString: string,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  const { pool, close } = createDb(connectionString, { max: 1 });
  try {
    const migrations = readMigrationFiles({ migrationsFolder });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize all phase runners before reading the shared ledger.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bos:migrations'))");
      await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
      await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
      )`);
      const applied = await client.query<{ hash: string }>(
        'SELECT hash FROM drizzle.__drizzle_migrations',
      );
      const hashes = new Set(applied.rows.map((row) => row.hash));
      // Phase branches can introduce older timestamps. A timestamp is ordering metadata,
      // not evidence that a particular SQL file was applied. Preserve all recorded hashes.
      for (const migration of migrations) {
        if (hashes.has(migration.hash)) continue;
        for (const statement of migration.sql) await client.query(statement);
        await client.query(
          'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [migration.hash, migration.folderMillis],
        );
        hashes.add(migration.hash);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
