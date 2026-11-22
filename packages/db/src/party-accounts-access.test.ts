// What the database gives the runtime role on app.party_accounts (a customer's terms with one legal entity: owner,
// currency, payment term, credit limit), the table the customer credit-limit and owner edits write to.
//
//   * Grants: no migration grants this table by name. 0008 sets default privileges for tables bos_owner creates in
//     `app` (SELECT, INSERT, UPDATE, DELETE to bos_app) and 0015 relies on them ("No GRANT").
//   * Row security: no migration enables it on any table. The acting entity is enforced by the API (every query names
//     tenant_id and organization_id from withTx's scope) and, in the database, only by the composite FKs:
//     (tenant_id, organization_id) -> organizations and (tenant_id, party_id) -> customers. So a row naming another
//     tenant's entity or customer is refused, but a row naming another entity of the SAME tenant is accepted: the
//     database does not compare the row's organization_id with bos.organization_id. The last test pins that down.
//   * Audit: 0015 attaches the audit trigger; the event takes tenant and entity from the row, and the actor from
//     withTx's bos.* settings.
//
// Writes run as bos_app with all seven bos.* settings, as apps/api/src/platform/db/tx.ts withTx sets them. Run with:
//   pnpm --filter @bos/db exec vitest run src/party-accounts-access.test.ts
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createParty, createTenantWithEntity, type TenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const ACTOR = 'party-accounts-access-test-user';

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;
let tenantA: TenantWithEntity;
let tenantB: TenantWithEntity;
let customerA: string;
let customerB: string;
let otherEntityA: string;

interface Scope {
  tenantId: string;
  organizationId: string;
}

/** One transaction as bos_app with the scope and actor withTx sets. */
async function withTxAsApp<T>(scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('bos.tenant_id', $1, true),
              set_config('bos.organization_id', $2, true),
              set_config('bos.actor_kind', 'user', true),
              set_config('bos.actor_id', $3, true),
              set_config('bos.correlation_id', $4, true),
              set_config('bos.ip', '', true),
              set_config('bos.user_agent', '', true)`,
      [scope.tenantId, scope.organizationId, ACTOR, `test-${randomUUID()}`],
    );
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

async function insertCustomer(org: TenantWithEntity): Promise<string> {
  const { partyId } = await createParty(owner, { tenantId: org.tenantId, kind: 'customer' });
  await withTxAsApp(org, (c) =>
    c.query(
      `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address_line, address_city)
       VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', 'Durbar Marg 1', 'Kathmandu')`,
      [partyId, org.tenantId, `CUS-${partyId.slice(0, 8)}`],
    ),
  );
  return partyId;
}

function insertAccount(scope: Scope, partyId: string, creditLimit: string): Promise<string> {
  return withTxAsApp(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.party_accounts (tenant_id, organization_id, party_id, credit_limit)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [scope.tenantId, scope.organizationId, partyId, creditLimit],
    );
    return rows[0]!.id;
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
  tenantA = await createTenantWithEntity(owner);
  tenantB = await createTenantWithEntity(owner);
  customerA = await insertCustomer(tenantA);
  customerB = await insertCustomer(tenantB);
  otherEntityA = randomUUID();
  await withTxAsApp(tenantA, (c) =>
    c.query(
      `INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
       VALUES ($1, $2, $1, $3, $3, $3, false)`,
      [otherEntityA, tenantA.tenantId, `E-${otherEntityA.slice(0, 8)}`],
    ),
  );
}, 180_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

describe('app.party_accounts for the runtime role', () => {
  it('gives bos_app SELECT, INSERT and UPDATE, and has no row security', async () => {
    const { rows } = await owner.query<Record<string, boolean>>(
      `SELECT has_table_privilege('bos_app', 'app.party_accounts', 'SELECT') AS select,
              has_table_privilege('bos_app', 'app.party_accounts', 'INSERT') AS insert,
              has_table_privilege('bos_app', 'app.party_accounts', 'UPDATE') AS update,
              c.relrowsecurity AS rls
         FROM pg_class c WHERE c.oid = 'app.party_accounts'::regclass`,
    );
    expect(rows[0]).toEqual({ select: true, insert: true, update: true, rls: false });
  });

  it('inserts then updates a row of the acting entity, and audits both with the actor', async () => {
    const id = await insertAccount(tenantA, customerA, '100000.00');
    await withTxAsApp(tenantA, (c) =>
      c.query(
        `UPDATE app.party_accounts SET credit_limit = '250000.00', version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND organization_id = $2 AND id = $3`,
        [tenantA.tenantId, tenantA.organizationId, id],
      ),
    );
    const read = await withTxAsApp(tenantA, (c) =>
      c.query<{ credit_limit: string; version: number }>(
        'SELECT credit_limit, version FROM app.party_accounts WHERE tenant_id = $1 AND id = $2',
        [tenantA.tenantId, id],
      ),
    );
    expect(read.rows).toEqual([{ credit_limit: '250000.00', version: 2 }]);

    const { rows } = await owner.query<{
      action: string;
      actor_id: string;
      organization_id: string;
      credit_limit: string;
    }>(
      `SELECT action, actor_id, organization_id, after ->> 'credit_limit' AS credit_limit
         FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'party_accounts' AND entity_id = $2
        ORDER BY seq`,
      [tenantA.tenantId, id],
    );
    expect(rows).toEqual([
      {
        action: 'party_accounts.insert',
        actor_id: ACTOR,
        organization_id: tenantA.organizationId,
        credit_limit: '100000.00',
      },
      {
        action: 'party_accounts.update',
        actor_id: ACTOR,
        organization_id: tenantA.organizationId,
        credit_limit: '250000.00',
      },
    ]);
  });

  it("refuses a row naming another tenant's entity", async () => {
    await expect(
      insertAccount(
        { tenantId: tenantA.tenantId, organizationId: tenantB.organizationId },
        customerA,
        '1.00',
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'party_accounts_tenant_org_fk' });
  });

  it("refuses a row naming another tenant's customer", async () => {
    await expect(insertAccount(tenantA, customerB, '1.00')).rejects.toMatchObject({
      code: '23503',
      constraint: 'party_accounts_customer_fk',
    });
  });

  it('accepts a row for another entity of the same tenant (no database check against the acting entity)', async () => {
    // Acting entity is tenant A's default entity, but the row names its second entity. Nothing in the database
    // refuses it; the audit event takes the row's entity. The API's WHERE clauses are the only guard here.
    const id = await withTxAsApp(tenantA, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO app.party_accounts (tenant_id, organization_id, party_id, credit_limit)
         VALUES ($1, $2, $3, '1.00') RETURNING id`,
        [tenantA.tenantId, otherEntityA, customerA],
      );
      return rows[0]!.id;
    });
    const { rows } = await owner.query<{ organization_id: string }>(
      `SELECT organization_id FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'party_accounts' AND entity_id = $2`,
      [tenantA.tenantId, id],
    );
    expect(rows).toEqual([{ organization_id: otherEntityA }]);
  });
});
