// Integration test for migration 0196 (R6A): a phone of a shared calling code is stored with the code's main country.
//   * customer, vendor and lead phone rows whose country is a smaller country of the number's calling code (GG, VA,
//     ...) become the main country (GB, IT); the number itself is not touched; +1 and +7 rows (CA, KZ) stay;
//   * a row that already has the main country, a country of another calling code, or no shared code stays as it is;
//   * the latest entity.profile gets a next version with the same change in its phones (older versions stay);
//   * what it writes is audited as system:migration-0196, and a second run writes nothing.
// Migrates to just before 0196, seeds the old shapes, then runs 0196 through the migrator and once more by hand.
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Run with:
//   pnpm --filter @bos/db exec vitest run src/party-phone-main-country-migration.test.ts
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0196_party_phone_main_country';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let pool: Pool;
let org: TenantWithEntity;
const folders: string[] = [];
const ids = { customerContact: '', vendorContact: '', lead: '' };

/** Runs fn in one transaction as a test actor with the tenant's default entity acting. */
async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'party-phone-main-country-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.organization_id', $2, true)`,
      [randomUUID(), org.organizationId],
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

const exec = (text: string, params: unknown[] = []) =>
  inTx(async (c) => (await c.query<{ id?: string }>(text, params)).rows[0]?.id ?? '');

/** Phone rows as (country, e164), in a stable order, for one owner table. */
async function phones(table: string, ownerColumn: string, ownerId: string) {
  const { rows } = await pool.query<{ country: string; e164: string }>(
    `SELECT country, e164 FROM app.${table} WHERE ${ownerColumn} = $1 ORDER BY sort_order`,
    [ownerId],
  );
  return rows.map((r) => [r.country, r.e164]);
}

const COUNTRIES: [string, string][] = [
  ['GG', '+447911123456'], // Guernsey pattern of +44 -> GB
  ['JE', '+447797123456'], // Jersey -> GB
  ['VA', '+390669812345'], // Vatican -> IT
  ['CA', '+14165550100'], // +1 and +7 follow the number itself: stays
  ['KZ', '+77012345678'], // stays
  ['GB', '+442071838750'], // already the main country: untouched
  ['NP', '+9779812345678'], // not a shared code: untouched
  ['IN', '+919812345678'], // not a shared code: untouched
  ['FR', '+447700900123'], // a country of another calling code than the number's: left alone
];

async function seedPhones(
  table: string,
  ownerColumns: string,
  ownerValues: unknown[],
): Promise<void> {
  const marks = ownerValues.map((_, i) => `$${i + 1}`).join(', ');
  for (const [index, [country, e164]] of COUNTRIES.entries()) {
    await exec(
      `INSERT INTO app.${table} (${ownerColumns}, country, e164, sort_order, is_primary)
       VALUES (${marks}, $${ownerValues.length + 1}, $${ownerValues.length + 2}, ${index}, ${index === 0})`,
      [...ownerValues, country, e164],
    );
  }
}

const migrationAudits = async (): Promise<string> =>
  String(
    (
      await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.audit_events WHERE actor_id = 'system:migration-0196'`,
      )
    ).rows[0]?.n,
  );

async function runAgain(): Promise<void> {
  const statements = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) {
      if (statement.trim() !== '') await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const PROFILE = (phones: unknown[]) => ({
  displayName: 'Acme',
  logoDocumentId: null,
  phones,
  email: null,
  website: null,
  panVatNo: null,
  signatoryName: null,
  signatoryTitle: null,
});

let auditsAfterFirstRun = '';

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  pool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  const folderOf = async (name: string, end: number): Promise<string> => {
    const folder = await mkdtemp(join(tmpdir(), `bos-${name}-`));
    folders.push(folder);
    await mkdir(join(folder, 'meta'));
    const entries = journal.entries.slice(0, end);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    return folder;
  };
  await runMigrations(testDb.ownerUrl, await folderOf('before-0196', index));

  org = await createTenantWithEntity(pool);
  const { userId } = await createStaffUser(pool, {
    tenantId: org.tenantId,
    organizationId: org.organizationId,
    idpOrgId: org.idpOrgId,
  });
  const { partyId } = await createParty(pool, { tenantId: org.tenantId, kind: 'customer' });
  await exec(
    `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city)
     VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', 'NP', 'Durbar Marg 1', 'Kathmandu')`,
    [partyId, org.tenantId, `CUS-${partyId.slice(0, 8)}`],
  );
  ids.customerContact = await exec(
    `INSERT INTO app.customer_contacts (tenant_id, customer_id, full_name)
     VALUES ($1, $2, 'Sita') RETURNING id`,
    [org.tenantId, partyId],
  );
  await seedPhones('customer_contact_phones', 'tenant_id, contact_id', [
    org.tenantId,
    ids.customerContact,
  ]);

  const vendor = await createParty(pool, { tenantId: org.tenantId, kind: 'vendor' });
  await exec(
    `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, country, created_by)
     VALUES ($1, $2, 'Globex Inc.', 'foreign', 'US', $3)`,
    [vendor.partyId, org.tenantId, userId],
  );
  ids.vendorContact = await exec(
    `INSERT INTO app.vendor_contacts (tenant_id, vendor_id, full_name)
     VALUES ($1, $2, 'Hank') RETURNING id`,
    [org.tenantId, vendor.partyId],
  );
  await seedPhones('vendor_contact_phones', 'tenant_id, contact_id', [
    org.tenantId,
    ids.vendorContact,
  ]);

  ids.lead = await exec(
    `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, company_name, contact_name)
     VALUES ($1, $2, $3, 'Website', 'website', 'Acme', 'Sita') RETURNING id`,
    [org.tenantId, org.organizationId, `LD-${randomUUID().slice(0, 8)}`],
  );
  await seedPhones('lead_phones', 'tenant_id, organization_id, lead_id', [
    org.tenantId,
    org.organizationId,
    ids.lead,
  ]);

  const settingRow = (version: number, value: unknown) =>
    exec(
      `INSERT INTO app.settings (tenant_id, organization_id, key, version, value)
       VALUES ($1, $2, 'entity.profile', $3, $4::jsonb)`,
      [org.tenantId, org.organizationId, version, JSON.stringify(value)],
    );
  await settingRow(1, PROFILE([{ country: 'GG', e164: '+447911123456', label: null }]));
  await settingRow(
    2,
    PROFILE([
      { country: 'GG', e164: '+447911123456', label: null },
      { country: 'NP', e164: '+9779812345678', label: 'mobile' },
      { country: 'VA', e164: '+390669812345', label: 'work' },
    ]),
  );

  await runMigrations(testDb.ownerUrl, await folderOf('through-0196', index + 1));
  auditsAfterFirstRun = await migrationAudits();
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

const EXPECTED = [
  ['GB', '+447911123456'],
  ['GB', '+447797123456'],
  ['IT', '+390669812345'],
  ['CA', '+14165550100'],
  ['KZ', '+77012345678'],
  ['GB', '+442071838750'],
  ['NP', '+9779812345678'],
  ['IN', '+919812345678'],
  ['FR', '+447700900123'],
];

describe('0196 party phone main country', () => {
  it('stores the main country of a shared calling code on contact and lead phones', async () => {
    expect(await phones('customer_contact_phones', 'contact_id', ids.customerContact)).toEqual(
      EXPECTED,
    );
    expect(await phones('vendor_contact_phones', 'contact_id', ids.vendorContact)).toEqual(
      EXPECTED,
    );
    expect(await phones('lead_phones', 'lead_id', ids.lead)).toEqual(EXPECTED);
  });

  it('writes the next entity.profile version with the main countries and keeps the old ones', async () => {
    const { rows } = await pool.query<{
      version: number;
      value: { phones: { country: string; e164: string; label: string | null }[] };
      created_by: string | null;
    }>(
      `SELECT version, value, created_by FROM app.settings
        WHERE tenant_id = $1 AND organization_id = $2 AND key = 'entity.profile' ORDER BY version`,
      [org.tenantId, org.organizationId],
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(rows[1]?.value.phones[0]?.country).toBe('GG');
    expect(rows[2]?.created_by).toBeNull();
    expect(rows[2]?.value).toStrictEqual(
      PROFILE([
        { country: 'GB', e164: '+447911123456', label: null },
        { country: 'NP', e164: '+9779812345678', label: 'mobile' },
        { country: 'IT', e164: '+390669812345', label: 'work' },
      ]),
    );
  });

  it('audits what it wrote as the migration actor and writes nothing the second time', async () => {
    expect(Number(auditsAfterFirstRun)).toBeGreaterThanOrEqual(3 * 3 + 1);
    await runAgain();
    expect(await migrationAudits()).toBe(auditsAfterFirstRun);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM app.settings WHERE tenant_id = $1 AND key = 'entity.profile'`,
      [org.tenantId],
    );
    expect(rows[0]?.n).toBe('3');
  });
});
