// Integration test for migration 0069_default_term_sets_for_existing_tenants (D43) on a real postgres:16-alpine
// (Testcontainers, needs Docker).
// Run with: pnpm --filter @bos/db exec vitest run src/default-term-sets-migration.test.ts
//
// A company that already saved `quotation.term_presets` never saw the app's four default sets. The test drives the
// real SQL file through the real runner:
//   1. migrate a fresh database up to everything before 0069 (the journal is cut there, like the 0050 test),
//   2. seed term-set lists the way live companies hold them (append-only versions, owner role + bos.actor_*),
//   3. run the full runner, which applies 0069 to that populated database,
//   4. read the settings back, then execute the 0069 text again to prove it is idempotent.
// Without 0069 nothing is appended and every "gets the defaults" assertion below fails.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const KEY = 'quotation.term_presets';
const MIGRATION_TAG = '0069_default_term_sets_for_existing_tenants';

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
interface Preset {
  id: string;
  kind: string;
  name: string;
  body: string;
}

let testDb: TestDatabase;
let owner: Pool;
let databaseUrl: string;
let cutFolder: string;
let journal: { entries: JournalEntry[] };

const codes = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
type Code = (typeof codes)[number];
const entities = {} as Record<Code, { tenantId: string; organizationId: string }>;
let before: SettingRow[];
let after: SettingRow[];

const custom = (name: string, kind = 'terms_conditions'): Preset => ({
  id: randomUUID(),
  kind,
  name,
  body: `<p>${name}</p>`,
});
// The four default sets as the migration itself embeds them (a contracts test keeps this list equal to
// DEFAULT_TERM_PRESETS). The db package does not depend on @bos/contracts, so read them from the SQL.
let defaults: Preset[] = [];
const validList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 200 &&
  new Set((value as Preset[]).map((p) => `${p.kind}:${p.name.toLowerCase()}`)).size ===
    value.length;

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    const preamble: Record<string, string> = {
      'bos.actor_kind': 'system',
      'bos.actor_id': 'default-term-sets-migration-test',
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

async function seedEntity(c: PoolClient, code: Code): Promise<void> {
  const tenant = (
    await c.query<{ id: string }>('INSERT INTO app.tenants DEFAULT VALUES RETURNING id')
  ).rows[0]!.id;
  const org = await c.query<{ id: string }>(
    `INSERT INTO app.organizations (tenant_id, code, name, legal_name)
     VALUES ($1, $2, $2, $2 || ' Ltd') RETURNING id`,
    [tenant, code],
  );
  entities[code] = { tenantId: tenant, organizationId: org.rows[0]!.id };
}

async function saveSetting(
  c: PoolClient,
  code: Code,
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

function rowsOf(rows: SettingRow[], code: Code): SettingRow[] {
  const { tenantId, organizationId } = entities[code];
  return rows.filter(
    (r) => r.tenant_id === tenantId && r.organization_id === organizationId && r.key === KEY,
  );
}
const latestOf = (rows: SettingRow[], code: Code): SettingRow => {
  const list = rowsOf(rows, code);
  return list[list.length - 1]!;
};
const namesOf = (row: SettingRow): string[] => (row.value as Preset[]).map((p) => p.name);

async function statementsOf(tag: string): Promise<string[]> {
  const text = await readFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const A_OWN = custom('Our own terms');
const B_OWN_SAME_NAME = { ...custom('CASUAL WEBSITE TERMS'), body: '<p>Their wording</p>' };
const F_V1 = [custom('Old v1 set')];
const F_V2 = [custom('Newest v2 set')];
const E_FILLER = Array.from({ length: 199 }, (_, i) => custom(`Filler ${i}`, 'scope'));

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  databaseUrl = testDb.ownerUrl;
  owner = new Pool({ connectionString: databaseUrl, max: 2 });

  const sqlText = await readFile(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), 'utf8');
  defaults = JSON.parse(/jsonb_array_elements\('(.+?)'::jsonb\)/s.exec(sqlText)![1]!) as Preset[];
  expect(defaults).toHaveLength(4);

  journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  // Everything that exists before 0069: the state of a company that is live today.
  const cut = journal.entries.filter((e) => e.tag < MIGRATION_TAG);
  cutFolder = await mkdtemp(join(tmpdir(), 'bos-term-sets-'));
  await mkdir(join(cutFolder, 'meta'));
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

  await inTx(async (c) => {
    for (const code of codes) await seedEntity(c, code);
    // A saved one set of its own: it must keep it and gain all four defaults.
    await saveSetting(c, 'A', KEY, 1, [A_OWN]);
    // B saved a set with the same kind and name as a default (different case, own wording): never replaced.
    await saveSetting(c, 'B', KEY, 1, [B_OWN_SAME_NAME]);
    // C already holds every default (same ids): no new row.
    await saveSetting(c, 'C', KEY, 1, defaults);
    // D never saved the key: the code default applies, no row.
    await saveSetting(c, 'D', 'format.date_pattern', 1, 'dd-mm-yyyy');
    // E holds 199 sets: only one default fits under the 200-set limit.
    await saveSetting(c, 'E', KEY, 1, E_FILLER);
    // F saved twice: the newest version is the one that is extended.
    await saveSetting(c, 'F', KEY, 1, F_V1);
    await saveSetting(c, 'F', KEY, 2, F_V2);
  });
  before = await readSettings();
  await runMigrations(databaseUrl);
  after = await readSettings();
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
  if (cutFolder) await rm(cutFolder, { recursive: true, force: true });
});

describe('0069_default_term_sets_for_existing_tenants on real Postgres', () => {
  it('is journalled once, after 0063, with a later timestamp', () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.filter((t) => t === MIGRATION_TAG)).toHaveLength(1);
    expect(tags.indexOf(MIGRATION_TAG)).toBeGreaterThan(tags.indexOf('0063_follow_up_data'));
    const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG)!;
    const earlier = journal.entries.filter((e) => e.tag < MIGRATION_TAG).map((e) => e.when);
    expect(entry.when).toBeGreaterThan(Math.max(...earlier));
  });

  it('appends the four defaults after the company’s own set, as a new version', () => {
    const rows = rowsOf(after, 'A');
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    const latest = latestOf(after, 'A');
    expect((latest.value as Preset[])[0]).toEqual(A_OWN);
    expect((latest.value as Preset[]).slice(1)).toEqual(defaults);
    expect(validList(latest.value)).toBe(true);
  });

  it('skips a default whose kind and name (ignoring case) already exist and never replaces the company’s set', () => {
    const latest = latestOf(after, 'B');
    expect(latest.version).toBe(2);
    const list = latest.value as Preset[];
    expect(list[0]).toEqual(B_OWN_SAME_NAME);
    expect(list.filter((p) => p.name.toLowerCase() === 'casual website terms')).toHaveLength(1);
    expect(list.slice(1)).toEqual(defaults.filter((d) => d.name !== 'Casual website terms'));
    expect(validList(list)).toBe(true);
  });

  it('writes nothing for a company that already holds every default or never saved the key', () => {
    expect(rowsOf(after, 'C')).toHaveLength(1);
    expect(rowsOf(after, 'D')).toHaveLength(0);
  });

  it('stays within the 200-set limit', () => {
    const latest = latestOf(after, 'E');
    expect(latest.version).toBe(2);
    expect((latest.value as Preset[]).length).toBe(200);
    expect(namesOf(latest).slice(0, 199)).toEqual(E_FILLER.map((p) => p.name));
    expect(validList(latest.value)).toBe(true);
  });

  it('extends the newest version of a company that saved twice', () => {
    expect(rowsOf(after, 'F').map((r) => r.version)).toEqual([1, 2, 3]);
    expect(namesOf(latestOf(after, 'F'))).toEqual([
      ...F_V2.map((p) => p.name),
      ...defaults.map((d) => d.name),
    ]);
  });

  it('is append-only: earlier rows are unchanged and only the new versions were added', () => {
    const afterById = new Map(after.map((r) => [r.id, r]));
    for (const row of before) expect(afterById.get(row.id)).toEqual(row);
    const added = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(added.map((r) => r.key)).toEqual([KEY, KEY, KEY, KEY]);
    expect(added.map((r) => r.organization_id).sort()).toEqual(
      ['A', 'B', 'E', 'F'].map((c) => entities[c as Code].organizationId).sort(),
    );
  });

  it('is idempotent: executing the SQL file again adds no row', async () => {
    const statements = await statementsOf(MIGRATION_TAG);
    for (let run = 0; run < 2; run++) {
      await inTx(async (c) => {
        for (const statement of statements) await c.query(statement);
      });
    }
    expect(await readSettings()).toEqual(after);
  });

  it('records the migration in the ledger, in journal order', async () => {
    const { rows } = await owner.query<{ created_at: string }>(
      'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    expect(rows.map((r) => Number(r.created_at))).toEqual(journal.entries.map((e) => e.when));
  });
});
