// Integration test for migrations 0191-0195 (FX9): party country, three-field addresses and phone tables.
//   * 0191: a customer's jsonb address becomes address_line (line1 + ', ' + line2) and address_city, its country
//     comes from the address, contacts take their parent's country; written as system:migration-0191.
//   * 0192/0193: each old phone_e164 becomes its owner's one primary phone row, the country read from the calling
//     code (+977 only under FX8's Nepal rules); a code not on the list is dropped; leads.phones_search is filled.
//   * 0194: the old phone_e164 columns are gone.
//   * 0195: the latest entity.address and entity.profile get a next version in the new shapes; a previewed import
//     batch is expired.
//   * 0193 and 0195 run a second time without writing anything.
// Migrates to just before 0191, seeds the old shapes, then runs 0191-0193 and 0194-0195 in two stages so 0193 can
// be re-run while its source columns still exist. On a database without the new tables or columns it fails.
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Run with:
//   pnpm --filter @bos/db exec vitest run src/party-country-phones-migration.test.ts
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

const FIRST = '0191_party_country_address';
const TAGS = [
  FIRST,
  '0192_party_phones',
  '0193_party_phones_backfill',
  '0194_drop_owner_phone_e164',
  '0195_entity_settings_address_phones',
];

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let pool: Pool;
const folders: string[] = [];
let org: TenantWithEntity;
let userId: string;

const ids = {
  npCustomer: '',
  inCustomer: '',
  npMobileContact: '',
  usContact: '',
  unmappableContact: '',
  inContact: '',
  vendor: '',
  vendorContact: '',
  lead: '',
  badNepalLead: '',
  batch: '',
};

/** Row counts and values a second run of a data migration must leave exactly as they were. */
interface Snapshot {
  customerPhones: string;
  vendorPhones: string;
  leadPhones: string;
  phonesSearch: string;
  settings: string;
  audit: string;
}
let after0193: Snapshot;
let rerun0193: Snapshot;
let after0195: Snapshot;
let rerun0195: Snapshot;

/** Runs fn in one transaction as a test actor with the tenant's default entity acting; rolls back on a throw. */
async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'party-country-phones-test', true),
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

async function exec(text: string, params: unknown[] = []): Promise<string> {
  return inTx(async (c) => {
    const { rows } = await c.query<{ id?: string }>(text, params);
    return rows[0]?.id ?? '';
  });
}

async function customer(address: Record<string, unknown>): Promise<string> {
  const { partyId } = await createParty(pool, { tenantId: org.tenantId, kind: 'customer' });
  await exec(
    `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
     VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', $4::jsonb)`,
    [partyId, org.tenantId, `CUS-${partyId.slice(0, 8)}`, JSON.stringify(address)],
  );
  return partyId;
}

const customerContact = (customerId: string, name: string, phone: string | null) =>
  exec(
    `INSERT INTO app.customer_contacts (tenant_id, customer_id, full_name, phone_e164)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [org.tenantId, customerId, name, phone],
  );

const lead = (phone: string) =>
  exec(
    `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, company_name, contact_name, phone_e164)
     VALUES ($1, $2, $3, 'Website', 'website', 'Acme', 'Sita', $4) RETURNING id`,
    [org.tenantId, org.organizationId, `LD-${randomUUID().slice(0, 8)}`, phone],
  );

const setting = (key: string, version: number, value: unknown) =>
  exec(
    `INSERT INTO app.settings (tenant_id, organization_id, key, version, value)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [org.tenantId, org.organizationId, key, version, JSON.stringify(value)],
  );

async function count(text: string, params: unknown[] = []): Promise<string> {
  const { rows } = await pool.query<{ n: string }>(text, params);
  return String(rows[0]?.n);
}

async function snapshot(): Promise<Snapshot> {
  const t = [org.tenantId];
  return {
    customerPhones: await count(
      'SELECT count(*) AS n FROM app.customer_contact_phones WHERE tenant_id = $1',
      t,
    ),
    vendorPhones: await count(
      'SELECT count(*) AS n FROM app.vendor_contact_phones WHERE tenant_id = $1',
      t,
    ),
    leadPhones: await count('SELECT count(*) AS n FROM app.lead_phones WHERE tenant_id = $1', t),
    phonesSearch: await count(
      `SELECT string_agg(coalesce(phones_search, '-'), '|' ORDER BY id) AS n FROM app.leads WHERE tenant_id = $1`,
      t,
    ),
    settings: await count('SELECT count(*) AS n FROM app.settings WHERE tenant_id = $1', t),
    audit: await count(
      `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND actor_id LIKE 'system:migration-019%'`,
      t,
    ),
  };
}

/** Runs a migration file's statements again, in one transaction, the way the runner does. */
async function runAgain(tag: string): Promise<void> {
  const statements = (await readFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8')).split(
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

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  pool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === FIRST);
  expect(index, `${FIRST} is in the journal`).toBeGreaterThan(0);
  expect(journal.entries.slice(index, index + TAGS.length).map((e) => e.tag)).toEqual(TAGS);
  /** A migrations folder holding the journal's first `end` entries. */
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
  await runMigrations(testDb.ownerUrl, await folderOf('before-0191', index));

  // The old shapes, as the FX8 contracts saved them.
  org = await createTenantWithEntity(pool);
  ({ userId } = await createStaffUser(pool, {
    tenantId: org.tenantId,
    organizationId: org.organizationId,
    idpOrgId: org.idpOrgId,
  }));
  ids.npCustomer = await customer({
    line1: 'Durbar Marg 1',
    line2: 'Ward 1',
    city: 'Kathmandu',
    district: 'Kathmandu',
    province: 'Bagmati',
    postalCode: '44600',
    country: 'NP',
  });
  ids.inCustomer = await customer({ line1: 'MG Road 5', city: 'Bengaluru', country: 'IN' });
  ids.npMobileContact = await customerContact(ids.npCustomer, 'Sita', '+9779812345678');
  ids.usContact = await customerContact(ids.npCustomer, 'John', '+14155552671');
  ids.unmappableContact = await customerContact(ids.inCustomer, 'Ola', '+4790000000');
  ids.inContact = await customerContact(ids.inCustomer, 'Ravi', null);

  const vendorParty = await createParty(pool, { tenantId: org.tenantId, kind: 'vendor' });
  ids.vendor = vendorParty.partyId;
  await exec(
    `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, country, created_by)
     VALUES ($1, $2, 'Globex Inc.', 'foreign', 'US', $3)`,
    [ids.vendor, org.tenantId, userId],
  );
  ids.vendorContact = await exec(
    `INSERT INTO app.vendor_contacts (tenant_id, vendor_id, full_name, phone_e164)
     VALUES ($1, $2, 'Hank', '+14155550100') RETURNING id`,
    [org.tenantId, ids.vendor],
  );

  ids.lead = await lead('+919812345678');
  // A +977 number whose national part breaks FX8's Nepal rules (5 digits): not copied.
  ids.badNepalLead = await lead('+97712345');

  await setting('entity.address', 1, { line1: 'Old Road', city: 'Patan', country: 'NP' });
  await setting('entity.address', 2, {
    line1: 'Lazimpat 4',
    line2: 'Second floor',
    city: 'Kathmandu',
    province: 'Bagmati',
    postalCode: '44600',
    country: 'NP',
  });
  await setting('entity.profile', 1, {
    displayName: 'Acme',
    logoDocumentId: null,
    phones: ['+9779812345678', '+14155552671', '+4790000000'],
    email: null,
    website: null,
    panVatNo: null,
    signatoryName: null,
    signatoryTitle: null,
  });
  ids.batch = await exec(
    `INSERT INTO app.party_import_batches
       (tenant_id, organization_id, kind, file_name, row_count, valid_count, duplicate_count, error_count, rows, created_by)
     VALUES ($1, $2, 'customer', 'customers.csv', 1, 1, 0, 0, '[{"line": 2}]'::jsonb, $3) RETURNING id`,
    [org.tenantId, org.organizationId, userId],
  );

  await runMigrations(testDb.ownerUrl, await folderOf('through-0193', index + 3));
  after0193 = await snapshot();
  await runAgain('0193_party_phones_backfill');
  rerun0193 = await snapshot();

  await runMigrations(testDb.ownerUrl, await folderOf('through-0195', index + 5));
  after0195 = await snapshot();
  await runAgain('0195_entity_settings_address_phones');
  rerun0195 = await snapshot();
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

/** The audit events a migration actor wrote for one row. */
const auditedBy = (actor: string, entityId: string) =>
  count('SELECT count(*) AS n FROM audit.audit_events WHERE actor_id = $1 AND entity_id = $2', [
    actor,
    entityId,
  ]);

describe('0191 party country and address', () => {
  it('converts the jsonb address into line, city and country', async () => {
    const { rows } = await pool.query<{
      id: string;
      address_line: string;
      address_city: string;
      country: string;
    }>('SELECT id, address_line, address_city, country FROM app.customers WHERE tenant_id = $1', [
      org.tenantId,
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.npCustomer)).toMatchObject({
      address_line: 'Durbar Marg 1, Ward 1',
      address_city: 'Kathmandu',
      country: 'NP',
    });
    expect(byId.get(ids.inCustomer)).toMatchObject({
      address_line: 'MG Road 5',
      address_city: 'Bengaluru',
      country: 'IN',
    });
    expect(await auditedBy('system:migration-0191', ids.npCustomer)).toBe('1');
  });

  it('drops the jsonb address column', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'customers' AND column_name = 'address'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("gives contacts their parent's country and leads NP", async () => {
    const country = async (table: string, id: string) =>
      count(`SELECT country AS n FROM app.${table} WHERE id = $1`, [id]);
    expect(await country('customer_contacts', ids.npMobileContact)).toBe('NP');
    expect(await country('customer_contacts', ids.inContact)).toBe('IN');
    expect(await country('vendor_contacts', ids.vendorContact)).toBe('US');
    expect(await country('leads', ids.lead)).toBe('NP');
    expect(await auditedBy('system:migration-0191', ids.inContact)).toBe('1');
  });
});

describe('0192-0194 phones', () => {
  it('copies each mappable number as its owner’s one primary phone', async () => {
    const { rows } = await pool.query<{
      contact_id: string;
      country: string;
      e164: string;
      is_primary: boolean;
      sort_order: number;
    }>(
      'SELECT contact_id, country, e164, is_primary, sort_order FROM app.customer_contact_phones WHERE tenant_id = $1',
      [org.tenantId],
    );
    const byContact = new Map(rows.map((r) => [r.contact_id, r]));
    expect(byContact.get(ids.npMobileContact)).toMatchObject({
      country: 'NP',
      e164: '+9779812345678',
      is_primary: true,
      sort_order: 0,
    });
    expect(byContact.get(ids.usContact)).toMatchObject({ country: 'US', e164: '+14155552671' });
    expect(byContact.has(ids.unmappableContact)).toBe(false);
    expect(rows).toHaveLength(2);

    const vendor = await pool.query<{ country: string; e164: string; is_primary: boolean }>(
      'SELECT country, e164, is_primary FROM app.vendor_contact_phones WHERE contact_id = $1',
      [ids.vendorContact],
    );
    expect(vendor.rows).toEqual([{ country: 'US', e164: '+14155550100', is_primary: true }]);

    const leadRows = await pool.query<{ lead_id: string; country: string; e164: string }>(
      'SELECT lead_id, country, e164 FROM app.lead_phones WHERE tenant_id = $1',
      [org.tenantId],
    );
    expect(leadRows.rows).toEqual([{ lead_id: ids.lead, country: 'IN', e164: '+919812345678' }]);
  });

  it('audits every copied phone as system:migration-0193', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM app.customer_contact_phones WHERE tenant_id = $1
       UNION ALL SELECT id FROM app.vendor_contact_phones WHERE tenant_id = $1
       UNION ALL SELECT id FROM app.lead_phones WHERE tenant_id = $1`,
      [org.tenantId],
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(await auditedBy('system:migration-0193', row.id)).toBe('1');
  });

  it('fills leads.phones_search', async () => {
    expect(await count('SELECT phones_search AS n FROM app.leads WHERE id = $1', [ids.lead])).toBe(
      '+919812345678',
    );
    expect(
      await count('SELECT phones_search AS n FROM app.leads WHERE id = $1', [ids.badNepalLead]),
    ).toBe('null');
  });

  it('refuses a second primary phone for one owner', async () => {
    await expect(
      exec(
        `INSERT INTO app.customer_contact_phones (tenant_id, contact_id, country, e164, is_primary)
         VALUES ($1, $2, 'NP', '+9779801234567', true)`,
        [org.tenantId, ids.npMobileContact],
      ),
    ).rejects.toThrow(/customer_contact_phones_owner_primary_unique/);
  });

  it('drops the old phone_e164 columns', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'app' AND column_name = 'phone_e164'
          AND table_name IN ('customer_contacts', 'vendor_contacts', 'leads')`,
    );
    expect(rows).toHaveLength(0);
  });

  it('writes nothing when 0193 runs a second time', () => {
    expect(rerun0193).toEqual(after0193);
  });
});

describe('0195 entity settings and import previews', () => {
  const latest = async (key: string) => {
    const { rows } = await pool.query<{ version: number; value: unknown }>(
      `SELECT version, value FROM app.settings WHERE tenant_id = $1 AND organization_id = $2 AND key = $3
        ORDER BY version DESC LIMIT 1`,
      [org.tenantId, org.organizationId, key],
    );
    return rows[0];
  };

  it('writes the next entity.address version as line, city and country', async () => {
    expect(await latest('entity.address')).toEqual({
      version: 3,
      value: { line: 'Lazimpat 4, Second floor', city: 'Kathmandu', country: 'NP' },
    });
  });

  it('writes the next entity.profile version with per-number countries', async () => {
    const row = await latest('entity.profile');
    expect(row?.version).toBe(2);
    expect((row?.value as { phones: unknown }).phones).toEqual([
      { country: 'NP', e164: '+9779812345678', label: null },
      { country: 'US', e164: '+14155552671', label: null },
    ]);
  });

  it('expires the previewed import batch', async () => {
    const { rows } = await pool.query<{ status: string; rows: unknown }>(
      'SELECT status, rows FROM app.party_import_batches WHERE id = $1',
      [ids.batch],
    );
    expect(rows[0]).toEqual({ status: 'expired', rows: [] });
  });

  it('audits what it wrote as system:migration-0195', async () => {
    expect(
      await count(
        `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND actor_id = 'system:migration-0195'`,
        [org.tenantId],
      ),
    ).toBe('3');
  });

  it('writes nothing when 0195 runs a second time', () => {
    expect(rerun0195).toEqual(after0195);
  });
});
