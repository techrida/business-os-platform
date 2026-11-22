// Integration test for migration 0058_legacy_company_logo (U12): the latest `entity.profile` version of each entity
// that still holds `logoDataUrl` gets a next version with the value moved to `legacyLogoDataUrl` and
// `logoDocumentId` added, written by system:migration-0058. Older versions stay as history, other entities and
// tenants are untouched, and a second run inserts nothing.
// Needs Docker: a real postgres:16-alpine from Testcontainers. Run with:
//   pnpm --filter @bos/db exec vitest run src/legacy-company-logo-migration.test.ts
//
// The database is first migrated with the real SQL up to the migration before 0058, seeded with settings rows the
// way the pre-U12 SettingsService saved them, and then migrated with the real runner, which applies 0058 (and any
// later migration). Writes set the bos.* audit settings the triggers demand.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity, type TenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0058_legacy_company_logo';
const ACTOR = 'system:migration-0058';
const KEY = 'entity.profile';

const LOGO_OLD = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAA==';
const LOGO_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAA==';
const LOGO_F = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==';
const LOGO_G = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const EXISTING_DOC = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

/** The pre-U12 saved profile (CompanyProfileSchema before U12): every field, `logoDataUrl` included. */
function savedProfile(displayName: string, logoDataUrl: string | null): Record<string, unknown> {
  return {
    displayName,
    logoDataUrl,
    phones: [],
    email: 'office@example.test',
    website: 'https://example.test',
    panVatNo: null,
    signatoryName: 'R. Signer',
    signatoryTitle: 'Director',
  };
}

interface Entity {
  tenantId: string;
  organizationId: string;
}

interface SettingRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  key: string;
  version: number;
  value: unknown;
  created_by: string | null;
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let owner: Pool;
let ownerUrl: string;
let before0058Folder: string;
let sql0058: string[];

let tenantA: TenantWithEntity;
let tenantF: TenantWithEntity;
/** (a) two versions, the latest with a data URL (the default entity of tenant A). */
let caseA: Entity;
/** (b) the saved profile with `logoDataUrl: null`. */
let caseB: Entity;
/** (c) a profile without the logo key at all. */
let caseC: Entity;
/** (d) already a U12 profile: `logoDocumentId` set, no `logoDataUrl`. */
let caseD: Entity;
/** (e) the old version had a data URL, the latest has no `logoDataUrl`. */
let caseE: Entity;
/** (f) another tenant's data URL. */
let caseF: Entity;
/** (g, addition) both `logoDataUrl` and `logoDocumentId`: the document id is kept. */
let caseG: Entity;

/** Every entity.profile row of every entity, captured before 0058 ran. */
let before: SettingRow[];

/** One transaction as bos_owner with the audit settings the triggers need. */
async function writeAs<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'legacy-logo-migration-test', true),
              set_config('bos.correlation_id', $1, true)`,
      [randomUUID()],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A second legal entity of the tenant (the fixture made the default one). */
async function insertEntity(tenantId: string): Promise<Entity> {
  const id = randomUUID();
  await writeAs((client) =>
    client.query(
      `INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
       VALUES ($1, $2, $1, $3, $3, $3, false)`,
      [id, tenantId, `E-${id}`],
    ),
  );
  return { tenantId, organizationId: id };
}

/** Saves `entity.profile` versions 1..n of one entity, as the pre-U12 SettingsService did (created_by NULL). */
async function saveProfiles(entity: Entity, values: Record<string, unknown>[]): Promise<void> {
  await writeAs(async (client) => {
    for (const [index, value] of values.entries()) {
      await client.query(
        `INSERT INTO app.settings (tenant_id, organization_id, key, version, value)
         VALUES ($1, $2, $3, $4, $5)`,
        [entity.tenantId, entity.organizationId, KEY, index + 1, JSON.stringify(value)],
      );
    }
  });
}

async function profileRows(): Promise<SettingRow[]> {
  const { rows } = await owner.query<SettingRow>(
    `SELECT id, tenant_id, organization_id, key, version, value, created_by
       FROM app.settings
      WHERE key = $1
      ORDER BY tenant_id, organization_id, version`,
    [KEY],
  );
  return rows;
}

function rowsOf(rows: SettingRow[], entity: Entity): SettingRow[] {
  return rows.filter(
    (row) => row.tenant_id === entity.tenantId && row.organization_id === entity.organizationId,
  );
}

async function migrationAuditRows(): Promise<
  { tenant_id: string; organization_id: string; entity_id: string }[]
> {
  const { rows } = await owner.query<{
    tenant_id: string;
    organization_id: string;
    entity_id: string;
  }>(
    `SELECT tenant_id, organization_id, entity_id FROM audit.audit_events
      WHERE actor_id = $1 ORDER BY id`,
    [ACTOR],
  );
  return rows;
}

/** Runs the statements of 0058 as one transaction, the way the runner does. */
async function runSql0058Again(): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const statement of sql0058) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The one row 0058 added for a migrated entity, after checking the entity's old rows are kept unchanged. */
function migratedRow(after: SettingRow[], entity: Entity): SettingRow {
  const old = rowsOf(before, entity);
  const now = rowsOf(after, entity);
  expect(now).toHaveLength(old.length + 1);
  expect(now.slice(0, old.length)).toStrictEqual(old);
  const latestOld = old.at(-1);
  const added = now.at(-1);
  if (latestOld === undefined || added === undefined) throw new Error('no profile rows');
  expect(added.version).toBe(latestOld.version + 1);
  expect(added.created_by).toBeNull();
  return added;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  ownerUrl = testDb.ownerUrl;
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  // The real SQL and journal up to the migration before 0058.
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  before0058Folder = await mkdtemp(join(tmpdir(), 'bos-before-0058-'));
  await mkdir(join(before0058Folder, 'meta'));
  const entries = journal.entries.slice(0, index);
  await writeFile(
    join(before0058Folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(before0058Folder, `${entry.tag}.sql`),
    );
  }
  sql0058 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );

  await runMigrations(ownerUrl, before0058Folder);

  // Tenant A: one entity per case, so a migration that filtered by tenant alone would be caught.
  tenantA = await createTenantWithEntity(owner);
  caseA = { tenantId: tenantA.tenantId, organizationId: tenantA.organizationId };
  caseB = await insertEntity(tenantA.tenantId);
  caseC = await insertEntity(tenantA.tenantId);
  caseD = await insertEntity(tenantA.tenantId);
  caseE = await insertEntity(tenantA.tenantId);
  caseG = await insertEntity(tenantA.tenantId);

  await saveProfiles(caseA, [savedProfile('Acme v1', LOGO_OLD), savedProfile('Acme', LOGO_A)]);
  await saveProfiles(caseB, [savedProfile('No Logo Ltd', null)]);
  // Not a shape the pre-U12 save produced (it always carries the key); covers a hand-written or older value.
  const withoutLogoKey = savedProfile('Keyless', null);
  delete withoutLogoKey.logoDataUrl;
  await saveProfiles(caseC, [withoutLogoKey]);
  const u12Profile = savedProfile('Already U12', null);
  delete u12Profile.logoDataUrl;
  await saveProfiles(caseD, [{ ...u12Profile, logoDocumentId: EXISTING_DOC }]);
  const removedLogo = savedProfile('Logo Removed', null);
  delete removedLogo.logoDataUrl;
  await saveProfiles(caseE, [
    savedProfile('Logo Removed v1', LOGO_OLD),
    { ...removedLogo, logoDocumentId: null },
  ]);
  await saveProfiles(caseG, [
    { ...savedProfile('Both Keys', LOGO_G), logoDocumentId: EXISTING_DOC },
  ]);

  // Tenant F: another tenant's data URL.
  tenantF = await createTenantWithEntity(owner);
  caseF = { tenantId: tenantF.tenantId, organizationId: tenantF.organizationId };
  await saveProfiles(caseF, [savedProfile('Other Tenant', LOGO_F)]);

  before = await profileRows();
  expect(before).toHaveLength(9);
  expect(await migrationAuditRows()).toHaveLength(0);

  // The real runner now applies 0058 (and any later migration).
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
  if (before0058Folder) await rm(before0058Folder, { recursive: true, force: true });
});

describe('0058 legacy company logo', () => {
  it('moves the latest data URL to legacyLogoDataUrl in the next version, other fields kept', async () => {
    const added = migratedRow(await profileRows(), caseA);
    const { logoDataUrl: _moved, ...rest } = savedProfile('Acme', LOGO_A);
    expect(added.value).toStrictEqual({
      ...rest,
      logoDocumentId: null,
      legacyLogoDataUrl: LOGO_A,
    });
    expect(added.value).not.toHaveProperty('logoDataUrl');
  });

  it('moves a null logoDataUrl as a null legacyLogoDataUrl', async () => {
    const added = migratedRow(await profileRows(), caseB);
    const { logoDataUrl: _moved, ...rest } = savedProfile('No Logo Ltd', null);
    expect(added.value).toStrictEqual({ ...rest, logoDocumentId: null, legacyLogoDataUrl: null });
    expect(added.value).toHaveProperty('legacyLogoDataUrl', null);
    expect(added.value).not.toHaveProperty('logoDataUrl');
  });

  it('migrates another tenant independently', async () => {
    const added = migratedRow(await profileRows(), caseF);
    const { logoDataUrl: _moved, ...rest } = savedProfile('Other Tenant', LOGO_F);
    expect(added.value).toStrictEqual({ ...rest, logoDocumentId: null, legacyLogoDataUrl: LOGO_F });
  });

  it('keeps an existing logoDocumentId when the latest version also has a data URL', async () => {
    const added = migratedRow(await profileRows(), caseG);
    const { logoDataUrl: _moved, ...rest } = savedProfile('Both Keys', LOGO_G);
    expect(added.value).toStrictEqual({
      ...rest,
      logoDocumentId: EXISTING_DOC,
      legacyLogoDataUrl: LOGO_G,
    });
  });

  it('leaves entities whose latest profile has no logoDataUrl untouched, older data URLs included', async () => {
    const after = await profileRows();
    for (const entity of [caseC, caseD, caseE]) {
      expect(rowsOf(after, entity)).toStrictEqual(rowsOf(before, entity));
    }
    // (e): the data URL in version 1 is history and stays where it is.
    expect(rowsOf(after, caseE).map((row) => row.version)).toEqual([1, 2]);
    expect(rowsOf(after, caseE)[0]?.value).toHaveProperty('logoDataUrl', LOGO_OLD);
  });

  it('adds exactly one row per migrated entity and nothing else', async () => {
    const after = await profileRows();
    expect(after).toHaveLength(before.length + 4);
  });

  it('audits each new version as system:migration-0058, under the row tenant and entity', async () => {
    const after = await profileRows();
    const audits = await migrationAuditRows();
    const expected = [caseA, caseB, caseF, caseG].map((entity) => {
      const added = rowsOf(after, entity).at(-1);
      return {
        tenant_id: entity.tenantId,
        organization_id: entity.organizationId,
        entity_id: added?.id,
      };
    });
    expect(audits).toHaveLength(4);
    expect([...audits].sort((x, y) => x.entity_id.localeCompare(y.entity_id))).toStrictEqual(
      [...expected].sort((x, y) => String(x.entity_id).localeCompare(String(y.entity_id))),
    );
  });

  it('inserts nothing when its statements run again', async () => {
    const rowsBefore = await profileRows();
    const auditsBefore = await migrationAuditRows();
    await runSql0058Again();
    await runSql0058Again();
    expect(await profileRows()).toStrictEqual(rowsBefore);
    expect(await migrationAuditRows()).toStrictEqual(auditsBefore);
  });

  it('is not re-applied by the runner', async () => {
    const rowsBefore = await profileRows();
    await runMigrations(ownerUrl);
    expect(await profileRows()).toStrictEqual(rowsBefore);
  });
});
