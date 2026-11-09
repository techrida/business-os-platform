import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let p3Folder: string;
let journal: { entries: JournalEntry[] };
let sequence = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query("CREATE ROLE bos_owner LOGIN PASSWORD 'owner-test-pw'");
  await admin.query('CREATE ROLE bos_app');
  journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  // The actual P3 SQL and journal, up to p3-done's final migration, run before the combined runner.
  p3Folder = await mkdtemp(join(tmpdir(), 'bos-migrate-p3-'));
  await mkdir(join(p3Folder, 'meta'));
  const entries = journal.entries.filter((entry) => entry.idx <= 24);
  await writeFile(join(p3Folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(p3Folder, `${entry.tag}.sql`));
  }
});

afterAll(async () => {
  await admin?.end();
  await container?.stop();
  if (p3Folder) await rm(p3Folder, { recursive: true, force: true });
});

async function inDatabase(check: (url: string, pool: Pool) => Promise<void>): Promise<void> {
  const name = `migration_case_${++sequence}`;
  await admin.query(`CREATE DATABASE ${name} OWNER bos_owner`);
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  url.username = 'bos_owner';
  url.password = 'owner-test-pw';
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    await check(url.toString(), pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
  }
}

async function expectComplete(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ created_at: string }>(
    'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
  );
  expect(rows.map((row) => Number(row.created_at))).toEqual(
    journal.entries.map((entry) => entry.when),
  );
  const tables = await pool.query<{ sales: string; payables: string }>(
    "SELECT to_regclass('app.sales_orders')::text AS sales, to_regclass('app.vendor_bills')::text AS payables",
  );
  expect(tables.rows[0]).toEqual({ sales: 'app.sales_orders', payables: 'app.vendor_bills' });
}

describe('migration history on real Postgres', () => {
  it('migrates a fresh database and remains idempotent', async () => {
    await inDatabase(async (url, pool) => {
      await runMigrations(url);
      await runMigrations(url);
      await expectComplete(pool);
      // Either field stored by Drizzle is sufficient to identify an already-applied migration.
      const file = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })[20]!;
      await pool.query('UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE created_at = $2', [
        'legacy-hash',
        file.folderMillis,
      ]);
      await expect(runMigrations(url)).resolves.toBeUndefined();
      await pool.query(
        'UPDATE drizzle.__drizzle_migrations SET hash = $1, created_at = 1 WHERE created_at = $2',
        [file.hash, file.folderMillis],
      );
      await expect(runMigrations(url)).resolves.toBeUndefined();
    });
  });

  it('upgrades the real p3-done migration state to the combined P3/P4 schema', async () => {
    await inDatabase(async (url, pool) => {
      const handle = createDb(url, { max: 1 });
      try {
        await migrate(handle.db, { migrationsFolder: p3Folder });
      } finally {
        await handle.close();
      }
      await runMigrations(url);
      await expectComplete(pool);
    });
  });

  it('refuses a P4-line history missing P3 0020-0024 before running any migration', async () => {
    await inDatabase(async (url, pool) => {
      // Simulate Drizzle's rows on the already-pushed P4 line; no shared dev database is used.
      await pool.query('CREATE SCHEMA drizzle');
      await pool.query(
        'CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
      );
      const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
      for (const file of files) {
        const entry = journal.entries.find((item) => item.when === file.folderMillis)!;
        if (entry.idx >= 20 && entry.idx <= 24) continue;
        await pool.query(
          'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [file.hash, file.folderMillis],
        );
      }
      const before = await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
      await expect(runMigrations(url)).rejects.toThrow(
        /0020_sales_orders.*0021_invoices.*0022_payments.*0023_invoice_credit_release.*0024_credit_note_line_link.*apply them in order/i,
      );
      expect(
        (await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
      ).toEqual(before.rows);
      expect(
        (await pool.query<{ schema: string | null }>("SELECT to_regnamespace('app') AS schema"))
          .rows[0]?.schema,
      ).toBeNull();
    });
  });
});
