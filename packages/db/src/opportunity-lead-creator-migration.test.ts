// Integration test for migrations 0101 and 0102 (FX-Q1): an opportunity converted from a lead before 0101 gets the
// creator of that lead, and nothing else changes.
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/opportunity-lead-creator-migration.test.ts
//
// The database is migrated with the real SQL up to 0100 and given converted opportunities the way the API wrote
// them before 0101 (no lead creator column at all). Then the real runner applies 0101, 0102 and anything later.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';

const OWNER_PW = 'owner-test-pw';
const FIRST_TAG = '0101_opportunity_lead_creator';
const BACKFILL_TAG = '0102_opportunity_lead_creator_backfill';
const ACTOR = 'system:migration-0102';
const ADDRESS = JSON.stringify({ line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' });

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let beforeFolder: string;
let sql0102: string[];

let tenant: TenantWithEntity;
let creator: string;
let salesOwner: string;
let customerId: string;

const opp = {} as {
  fromCreatedLead: string;
  fromLeadWithoutCreator: string;
  withoutLead: string;
};

/** One transaction as bos_owner in the tenant's entity, with the audit settings the triggers demand. */
async function writeAs<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'opportunity-lead-creator-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.tenant_id', $2, true),
              set_config('bos.organization_id', $3, true)`,
      [randomUUID(), tenant.tenantId, tenant.organizationId],
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

/** A converted lead entered by `createdBy`, and the opportunity it became, as the pre-0101 API wrote them. */
async function convertedLead(createdBy: string | null): Promise<string> {
  return writeAs(async (c) => {
    const lead = await c.query<{ id: string }>(
      `INSERT INTO app.leads
         (tenant_id, organization_id, number, title, source, owner_user_id, company_name, contact_name,
          created_by_user_id)
       VALUES ($1, $2, $3, 'Lead', 'website', $4, 'Acme', 'Asha', $5) RETURNING id`,
      [
        tenant.tenantId,
        tenant.organizationId,
        `LD-${randomUUID().slice(0, 8)}`,
        salesOwner,
        createdBy,
      ],
    );
    return insertOpportunity(c, lead.rows[0]!.id);
  });
}

async function insertOpportunity(c: PoolClient, leadId: string | null): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO app.opportunities
       (tenant_id, organization_id, number, name, customer_id, lead_id, owner_user_id)
     VALUES ($1, $2, $3, 'Deal', $4, $5, $6) RETURNING id`,
    [
      tenant.tenantId,
      tenant.organizationId,
      `DEAL-${randomUUID().slice(0, 8)}`,
      customerId,
      leadId,
      salesOwner,
    ],
  );
  return rows[0]!.id;
}

async function leadCreators(): Promise<Map<string, string | null>> {
  const { rows } = await owner.query<{ id: string; lead_creator_user_id: string | null }>(
    'SELECT id, lead_creator_user_id FROM app.opportunities WHERE tenant_id = $1',
    [tenant.tenantId],
  );
  return new Map(rows.map((row) => [row.id, row.lead_creator_user_id]));
}

async function migrationEvents(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM audit.audit_events WHERE actor_id = $1',
    [ACTOR],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query('CREATE ROLE bos_app');
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  const url = new URL(container.getConnectionUri());
  url.username = 'bos_owner';
  url.password = OWNER_PW;
  url.pathname = '/bos';
  const ownerUrl = url.toString();
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === FIRST_TAG);
  expect(index, `${FIRST_TAG} is in the journal`).toBeGreaterThan(0);
  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0101-'));
  await mkdir(join(beforeFolder, 'meta'));
  const entries = journal.entries.slice(0, index);
  await writeFile(
    join(beforeFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(beforeFolder, `${entry.tag}.sql`),
    );
  }
  sql0102 = (await readFile(join(MIGRATIONS_FOLDER, `${BACKFILL_TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  tenant = await createTenantWithEntity(owner);
  creator = (await createStaffUser(owner, tenant)).userId;
  salesOwner = (await createStaffUser(owner, tenant)).userId;
  customerId = (await createParty(owner, { tenantId: tenant.tenantId, kind: 'customer' })).partyId;
  await writeAs((c) =>
    c.query(
      `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
       VALUES ($1, $2, 'CUS-1', 'Acme', 'acme', $3::jsonb)`,
      [customerId, tenant.tenantId, ADDRESS],
    ),
  );

  opp.fromCreatedLead = await convertedLead(creator);
  opp.fromLeadWithoutCreator = await convertedLead(null);
  opp.withoutLead = await writeAs((c) => insertOpportunity(c, null));

  // The real runner now applies 0101, 0102 and everything after them.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0101 and 0102 opportunity lead creator', () => {
  it('fills an opportunity with the creator of the lead it was converted from', async () => {
    expect((await leadCreators()).get(opp.fromCreatedLead)).toBe(creator);
  });

  it('leaves it empty when the lead has no creator, or there is no lead', async () => {
    const after = await leadCreators();
    expect(after.get(opp.fromLeadWithoutCreator)).toBeNull();
    expect(after.get(opp.withoutLead)).toBeNull();
  });

  it('records the fill in the audit trail as the migration, without raising the version', async () => {
    const { rows } = await owner.query<{
      before: string | null;
      after: string;
      before_version: string;
      after_version: string;
    }>(
      `SELECT before ->> 'lead_creator_user_id' AS before, after ->> 'lead_creator_user_id' AS after,
              before ->> 'version' AS before_version, after ->> 'version' AS after_version
         FROM audit.audit_events
        WHERE entity_type = 'opportunities' AND entity_id = $1 AND actor_id = $2`,
      [opp.fromCreatedLead, ACTOR],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ before: null, after: creator });
    expect(rows[0]!.after_version).toBe(rows[0]!.before_version);
    expect(await migrationEvents()).toBe(1);
  });

  it('never changes a value already set, and finds nothing to fill when it runs again', async () => {
    await writeAs((c) =>
      c.query('UPDATE app.opportunities SET lead_creator_user_id = $1 WHERE id = $2', [
        salesOwner,
        opp.fromCreatedLead,
      ]),
    );
    const before = await leadCreators();
    const eventsBefore = await migrationEvents();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0102) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect(await leadCreators()).toEqual(before);
    expect((await leadCreators()).get(opp.fromCreatedLead)).toBe(salesOwner);
    expect(await migrationEvents()).toBe(eventsBefore);
  });
});
