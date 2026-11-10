import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

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
