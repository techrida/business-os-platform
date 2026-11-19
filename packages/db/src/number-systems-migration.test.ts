// Integration test for migration 0050_number_systems_per_currency (D30) on a real postgres:16-alpine
// (Testcontainers, needs Docker).
// Run with: pnpm --filter @bos/db exec vitest run src/number-systems-migration.test.ts
//
// The single setting `format.number_system` becomes `format.number_systems`, one value per currency, per entity.
// The test drives the real SQL file through the real runner:
//   1. migrate a fresh database up to 0047 only (the journal is cut there, like migrate.test.ts does for P3),
//   2. seed settings the way a live company would hold them (append-only versions, written as the owner role
//      with the bos.actor_* preamble that the audit trigger on app.settings requires),
//   3. run the full runner, which applies 0050 and 0051 to that populated database,
//   4. read the settings back, then execute the 0050 text a second time to prove it is idempotent.
// Without 0050 (the old behaviour: no per-currency key is ever written) step 4's assertions find no
// `format.number_systems` row for any entity and fail.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';

const OWNER_PW = 'owner-test-pw';
const OLD_KEY = 'format.number_system';
const NEW_KEY = 'format.number_systems';
const MIGRATION_TAG = '0050_number_systems_per_currency';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface SettingRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  key: string;
  version: number;
  value: unknown;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let databaseUrl: string;
let cutFolder: string;
let journal: { entries: JournalEntry[] };

// One entity per scenario. Ids are filled in by the seed.
const entities: Record<'A' | 'B' | 'C' | 'D' | 'E', { tenantId: string; organizationId: string }> =
  {
    A: { tenantId: '', organizationId: '' },
    B: { tenantId: '', organizationId: '' },
    C: { tenantId: '', organizationId: '' },
    D: { tenantId: '', organizationId: '' },
    E: { tenantId: '', organizationId: '' },
  };
let before: SettingRow[];
let after: SettingRow[];

/** One transaction as the owner role, with the bos.* preamble the audit trigger needs (like withTx). */
async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const preamble: Record<string, string> = {
      'bos.actor_kind': 'system',
      'bos.actor_id': 'number-systems-migration-test',
      'bos.correlation_id': randomUUID(),
      'bos.ip': '',
      'bos.user_agent': '',
    };
    for (const [key, value] of Object.entries(preamble)) {
      await c.query('SELECT set_config($1, $2, true)', [key, value]);
    }
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

async function seedEntity(
  c: PoolClient,
  code: keyof typeof entities,
  tenantId?: string,
): Promise<void> {
  const tenant =
    tenantId ??
    (await c.query<{ id: string }>('INSERT INTO app.tenants DEFAULT VALUES RETURNING id')).rows[0]!
      .id;
  const org = await c.query<{ id: string }>(
    `INSERT INTO app.organizations (tenant_id, code, name, legal_name)
     VALUES ($1, $2, $2, $2 || ' Ltd') RETURNING id`,
    [tenant, code],
  );
  entities[code] = { tenantId: tenant, organizationId: org.rows[0]!.id };
}

async function saveSetting(
  c: PoolClient,
  code: keyof typeof entities,
  key: string,
  version: number,
  value: unknown,
): Promise<void> {
  await c.query(
    `INSERT INTO app.settings (tenant_id, organization_id, key, version, value)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [entities[code].tenantId, entities[code].organizationId, key, version, JSON.stringify(value)],
  );
}

async function readSettings(): Promise<SettingRow[]> {
  const { rows } = await owner.query<SettingRow>(
    `SELECT id, tenant_id, organization_id, key, version, value
       FROM app.settings ORDER BY tenant_id, organization_id, key, version`,
  );
  return rows;
}

function rowsOf(rows: SettingRow[], code: keyof typeof entities, key: string): SettingRow[] {
  const { tenantId, organizationId } = entities[code];
  return rows.filter(
    (r) => r.tenant_id === tenantId && r.organization_id === organizationId && r.key === key,
  );
}

/** The statements of one migration file, as drizzle splits them. */
async function statementsOf(tag: string): Promise<string[]> {
  const text = await readFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query('CREATE ROLE bos_app');
  await admin.query('CREATE DATABASE number_systems OWNER bos_owner');
  const url = new URL(container.getConnectionUri());
  url.pathname = '/number_systems';
  url.username = 'bos_owner';
  url.password = OWNER_PW;
  databaseUrl = url.toString();
  owner = new Pool({ connectionString: databaseUrl, max: 2 });

  journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };

  // The real journal and SQL up to and including 0047_quotation_terms_conditions: the state of a company
  // that is live today and has not yet received 0050.
  const last = journal.entries.find((e) => e.tag.startsWith('0047_'));
  expect(last, 'journal lists 0047').toBeDefined();
  cutFolder = await mkdtemp(join(tmpdir(), 'bos-number-systems-'));
  await mkdir(join(cutFolder, 'meta'));
  const cut = journal.entries.filter((e) => e.idx <= last!.idx);
  await writeFile(
    join(cutFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: cut }),
  );
  for (const entry of cut) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(cutFolder, `${entry.tag}.sql`),
    );
  }
  await runMigrations(databaseUrl, cutFolder);
  expect(await statementsOf(MIGRATION_TAG)).not.toHaveLength(0);
  const applied = await owner.query(
    `SELECT to_regclass('app.settings')::text AS settings,
            (SELECT count(*) FROM information_schema.columns
              WHERE table_schema = 'app' AND table_name = 'invoice_print_log'
                AND column_name = 'render_format')::int AS render_format`,
  );
  expect(applied.rows[0]).toEqual({ settings: 'app.settings', render_format: 0 });

  // Seed what companies hold before 0050. Settings are append-only, so each save is the next version.
  await inTx(async (c) => {
    await seedEntity(c, 'A');
    // B is a second entity of A's tenant: the choice is per entity, not per tenant.
    await seedEntity(c, 'B', entities.A.tenantId);
    await seedEntity(c, 'C');
    await seedEntity(c, 'D');
    await seedEntity(c, 'E');
    // A saved the old key twice; the latest version is south_asian.
    await saveSetting(c, 'A', OLD_KEY, 1, 'international');
    await saveSetting(c, 'A', OLD_KEY, 2, 'south_asian');
    // B saved it once.
    await saveSetting(c, 'B', OLD_KEY, 1, 'international');
    // C never saved the old key, but holds other settings.
    await saveSetting(c, 'C', 'format.date_pattern', 1, 'dd-mm-yyyy');
    // D holds a value that is neither accepted number system.
    await saveSetting(c, 'D', OLD_KEY, 1, 'metric');
    // E already has the new key (a hand-made row): it must not gain a competing version.
    await saveSetting(c, 'E', OLD_KEY, 1, 'south_asian');
    await saveSetting(c, 'E', NEW_KEY, 1, {
      NPR: 'international',
      INR: 'international',
      USD: 'south_asian',
    });
  });
  before = await readSettings();

  // The real runner applies 0050 and 0051 by hash to the populated database.
  await runMigrations(databaseUrl);
  after = await readSettings();
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (cutFolder) await rm(cutFolder, { recursive: true, force: true });
});

describe('0050_number_systems_per_currency on real Postgres', () => {
  it('is journalled after 0047 and before 0051, in that order', () => {
    const tags = journal.entries.map((e) => e.tag);
    const i47 = tags.findIndex((t) => t.startsWith('0047_'));
    expect(i47).toBeGreaterThanOrEqual(0);
    expect(tags.slice(i47 + 1, i47 + 3)).toEqual([
      '0050_number_systems_per_currency',
      '0051_render_format_snapshot',
    ]);
    const whens = journal.entries.map((e) => e.when);
    expect(whens).toEqual([...whens].sort((a, b) => a - b));
    // Two earlier migrations (both numbered 0037) share a timestamp, so uniqueness is not asserted.
  });

  it('gives an entity that saved south_asian last NPR and INR south_asian and USD international', () => {
    const rows = rowsOf(after, 'A', NEW_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: 1,
      value: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
    });
  });

  it('keeps international for NPR and INR when that is what the entity saved, per entity in one tenant', () => {
    expect(entities.A.tenantId).toBe(entities.B.tenantId);
    const rows = rowsOf(after, 'B', NEW_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: 1,
      value: { NPR: 'international', INR: 'international', USD: 'international' },
    });
  });

  it('writes nothing for an entity without the old key or with an unrecognised value', () => {
    expect(rowsOf(after, 'C', NEW_KEY)).toHaveLength(0);
    expect(rowsOf(after, 'D', NEW_KEY)).toHaveLength(0);
  });

  it('does not add a version to an entity that already has the new key', () => {
    const rows = rowsOf(after, 'E', NEW_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: 1,
      value: { NPR: 'international', INR: 'international', USD: 'south_asian' },
    });
  });

  it('is append-only: every earlier row is unchanged and exactly the two derived rows are new', () => {
    const afterById = new Map(after.map((r) => [r.id, r]));
    for (const row of before) expect(afterById.get(row.id)).toEqual(row);
    const added = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(added.map((r) => r.key)).toEqual([NEW_KEY, NEW_KEY]);
    expect(added.map((r) => r.organization_id).sort()).toEqual(
      [entities.A.organizationId, entities.B.organizationId].sort(),
    );
    // The old key keeps its full history for A.
    expect(rowsOf(after, 'A', OLD_KEY).map((r) => [r.version, r.value])).toEqual([
      [1, 'international'],
      [2, 'south_asian'],
    ]);
  });

  it('is idempotent: executing the SQL file again adds no row', async () => {
    const statements = await statementsOf(MIGRATION_TAG);
    for (let run = 0; run < 2; run++) {
      // The first statement sets transaction-local settings, so all of them share one transaction.
      await inTx(async (c) => {
        for (const statement of statements) await c.query(statement);
      });
    }
    const again = await readSettings();
    expect(again).toEqual(after);
  });

  it('adds the nullable jsonb render_format column to invoice_print_log (0051)', async () => {
    const { rows } = await owner.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'invoice_print_log' AND column_name = 'render_format'`,
    );
    expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
  });

  it('records 0050 and 0051 in the migration ledger, in journal order', async () => {
    const { rows } = await owner.query<{ created_at: string }>(
      'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    expect(rows.map((r) => Number(r.created_at))).toEqual(journal.entries.map((e) => e.when));
  });
});
