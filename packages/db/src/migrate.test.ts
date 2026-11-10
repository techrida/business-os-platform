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
      // Hashes, rather than timestamps alone, identify applied SQL in the combined runner.
      const file = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })[20]!;
      await pool.query('UPDATE drizzle.__drizzle_migrations SET created_at = 1 WHERE hash = $1', [
        file.hash,
      ]);
      await expect(runMigrations(url)).resolves.toBeUndefined();
      await pool.query('UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE hash = $2', [
        'legacy-hash',
        file.hash,
      ]);
      await expect(runMigrations(url)).rejects.toThrow('unknown applied SQL hash');
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
});

it('applies missing older phase migrations by hash and preserves the ledger on rerun', async () => {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const folder = await mkdtemp(join(tmpdir(), 'bos-phase-migrations-'));
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const entry = (idx: number, tag: string, when: number) => ({
    idx,
    tag,
    when,
    version: '7',
    breakpoints: true,
  });
  const base = entry(0, 'base', 14),
    memo = entry(1, 'memo', 37),
    crm = entry(1, 'crm', 15);
  const journal = async (entries: unknown[]) =>
    writeFile(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
    );
  try {
    await mkdir(join(folder, 'meta'));
    await writeFile(
      join(folder, 'base.sql'),
      "CREATE TABLE preserved (value text); INSERT INTO preserved VALUES ('seed');",
    );
    await writeFile(join(folder, 'memo.sql'), 'ALTER TABLE preserved ADD COLUMN memo text;');
    await writeFile(join(folder, 'crm.sql'), 'ALTER TABLE preserved ADD COLUMN crm text;');
    await journal([base, memo]);
    await runMigrations(container.getConnectionUri(), folder);
    const before = (await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id'))
      .rows;
    await journal([base, crm, { ...memo, idx: 2 }]);
    await runMigrations(container.getConnectionUri(), folder);
    await runMigrations(container.getConnectionUri(), folder);
    const after = (await pool.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    expect(after.slice(0, 2)).toEqual(before);
    expect(after).toHaveLength(3);
    expect((await pool.query('SELECT value, memo, crm FROM preserved')).rows).toEqual([
      { value: 'seed', memo: null, crm: null },
    ]);
    await writeFile(join(folder, 'base.sql'), 'CREATE TABLE tampered_source (value text);');
    await expect(runMigrations(container.getConnectionUri(), folder)).rejects.toThrow(
      'unknown applied SQL hash',
    );
    expect((await pool.query("SELECT to_regclass('public.tampered_source') AS name")).rows).toEqual(
      [{ name: null }],
    );
    await writeFile(
      join(folder, 'base.sql'),
      "CREATE TABLE preserved (value text); INSERT INTO preserved VALUES ('seed');",
    );
    await writeFile(
      join(folder, 'broken.sql'),
      'ALTER TABLE preserved ADD COLUMN rolled_back text; SELECT missing_column FROM preserved;',
    );
    await journal([base, crm, { ...memo, idx: 2 }, entry(3, 'broken', 38)]);
    await expect(runMigrations(container.getConnectionUri(), folder)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM drizzle.__drizzle_migrations')).rows).toHaveLength(3);
    expect(
      (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='preserved' AND column_name='rolled_back'",
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await pool.end();
    await container.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
