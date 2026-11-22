// Integration test for migration 0187_company_contacts_strict (FX8): the latest `entity.profile` and
// `entity.pan_vat_no` of each entity get a next version with convertible phones and PANs in the strict formats.
// A value that cannot be converted is left as stored, older versions stay, and a second run writes nothing.
// Needs Docker: a real postgres:16-alpine from Testcontainers. Run with:
//   pnpm --filter @bos/db exec vitest run src/company-contacts-strict-migration.test.ts
//
// The database is fully migrated; the test then seeds rows the way the loose contracts saved them and runs the
// migration's statements again, as one transaction, the way the runner does.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER } from './migrate.js';
import { createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const ACTOR = 'system:migration-0187';

let testDb: TestDatabase;
let owner: Pool;
let statements: string[];

interface Entity {
  tenantId: string;
  organizationId: string;
}

const profile = (phones: string[], panVatNo: string | null): Record<string, unknown> => ({
  displayName: 'Acme',
  logoDocumentId: null,
  phones,
  email: null,
  website: null,
  panVatNo,
  signatoryName: null,
  signatoryTitle: null,
});

async function writeAs(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'company-contacts-test', true),
              set_config('bos.correlation_id', $1, true)`,
      [randomUUID()],
    );
    await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function newEntity(): Promise<Entity> {
  const tenant = await createTenantWithEntity(owner);
  return { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
}

async function save(entity: Entity, key: string, values: unknown[]): Promise<void> {
  await writeAs(async (client) => {
    for (const [index, value] of values.entries()) {
      await client.query(
        `INSERT INTO app.settings (tenant_id, organization_id, key, version, value)
         VALUES ($1, $2, $3, $4, $5)`,
        [entity.tenantId, entity.organizationId, key, index + 1, JSON.stringify(value)],
      );
    }
  });
}

async function versions(entity: Entity, key: string) {
  const { rows } = await owner.query<{
    version: number;
    value: unknown;
    created_by: string | null;
  }>(
    `SELECT version, value, created_by FROM app.settings
      WHERE tenant_id = $1 AND organization_id = $2 AND key = $3 ORDER BY version`,
    [entity.tenantId, entity.organizationId, key],
  );
  return rows;
}

async function runAgain(): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

let convertible: Entity;
let mixed: Entity;
let already: Entity;
let hopeless: Entity;
let panOnly: Entity;

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  statements = (
    await readFile(join(MIGRATIONS_FOLDER, '0187_company_contacts_strict.sql'), 'utf8')
  ).split('--> statement-breakpoint');

  convertible = await newEntity();
  await save(convertible, 'entity.profile', [
    profile(['old'], null),
    profile(
      [
        '+977 1 5550100',
        '01-4123456',
        '00977 9812345678',
        '977 98-1234 5678',
        '9812345678',
        '(+1) 415 555 2671',
      ],
      '301-234-567',
    ),
  ]);
  await save(convertible, 'entity.pan_vat_no', ['301 234 567']);

  mixed = await newEntity();
  await save(mixed, 'entity.profile', [
    profile(['+977 9812345678', 'front desk', '4123456', '00960 3323456'], 'AB-1234'),
  ]);

  already = await newEntity();
  await save(already, 'entity.profile', [profile(['+9779812345678'], '301234567')]);
  await save(already, 'entity.pan_vat_no', ['301234567']);

  hopeless = await newEntity();
  await save(hopeless, 'entity.pan_vat_no', ['ab-1234']);

  panOnly = await newEntity();
  await save(panOnly, 'entity.profile', [profile([], null)]);

  await runAgain();
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
});

describe('0187 company contacts strict', () => {
  it('writes the next version with Nepal phones as E.164 and the PAN as nine digits', async () => {
    const rows = await versions(convertible, 'entity.profile');
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(rows[0]?.value).toMatchObject({ phones: ['old'] });
    expect(rows[2]?.created_by).toBeNull();
    expect(rows[2]?.value).toStrictEqual(
      profile(
        [
          '+97715550100',
          '+97714123456',
          '+9779812345678',
          '+9779812345678',
          '+9779812345678',
          '+14155552671',
        ],
        '301234567',
      ),
    );
    const pan = await versions(convertible, 'entity.pan_vat_no');
    expect(pan.map((r) => [r.version, r.value])).toEqual([
      [1, '301 234 567'],
      [2, '301234567'],
    ]);
  });

  it('converts what it can and leaves the rest as stored', async () => {
    const rows = await versions(mixed, 'entity.profile');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.value).toStrictEqual(
      profile(['+9779812345678', 'front desk', '4123456', '00960 3323456'], null),
    );
  });

  it('leaves a row that is already strict, and a PAN that is not nine digits, alone', async () => {
    expect(await versions(already, 'entity.profile')).toHaveLength(1);
    expect(await versions(already, 'entity.pan_vat_no')).toHaveLength(1);
    expect(await versions(hopeless, 'entity.pan_vat_no')).toHaveLength(1);
    expect(await versions(panOnly, 'entity.profile')).toHaveLength(1);
  });

  it('is idempotent and audits what it wrote as the migration actor', async () => {
    const before = await versions(convertible, 'entity.profile');
    await runAgain();
    expect(await versions(convertible, 'entity.profile')).toHaveLength(before.length);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events WHERE actor_id = $1`,
      [ACTOR],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(3);
  });
});
