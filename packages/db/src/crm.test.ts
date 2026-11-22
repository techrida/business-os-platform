// Integration tests for 0015_crm (P2 unit S1) on a real, empty postgres:16-alpine started by Testcontainers
// (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/crm.test.ts
//
// What 0015 must hold:
//   * the migrations apply on a fresh database, and the nine CRM tables exist;
//   * checkTenancy() with its defaults (strict) and checkAudit() find nothing;
//   * a row of one legal entity cannot point at another entity's row (an opportunity in entity A naming a lead
//     of entity B is refused by the composite FK);
//   * an activity has exactly one subject (zero and two are refused);
//   * a PAN/VAT number is unique within a tenant, and free across tenants;
//   * a stage outside the contracts' catalogue is refused;
//   * a customer's id must be a customer party, never a vendor party.
//
// Setup mirrors tenancy-fks.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app. Tenant-level rows (customers) are audited under the acting entity, which inTx()
// sets, like withTx.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import { createParty, createStaffUser, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const CRM_TABLES = [
  'customers',
  'customer_contacts',
  'verification_cases',
  'party_accounts',
  'leads',
  'opportunities',
  'requirements',
  'proposals',
  'activities',
] as const;

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

interface Scope {
  tenantId: string;
  organizationId: string;
}

/** Runs fn in one transaction as bos_app, with `organizationId` as the acting entity (like withTx). */
async function inTx<T>(organizationId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('bos.organization_id', $1, true)`, [organizationId]);
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

/** A second legal entity of `tenantId` (the fixture made the default one). */
async function insertEntity(tenantId: string): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
     VALUES ($1, $2, $1, $3, $3, $3, false)`,
    [id, tenantId, `E-${id}`],
  );
  return id;
}

/** A customer party and its customer row, written in `scope`'s entity. */
async function insertCustomer(scope: Scope, panVatNo: string | null = null): Promise<string> {
  const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'customer' });
  await insertCustomerRow(scope, partyId, panVatNo);
  return partyId;
}

function insertCustomerRow(scope: Scope, id: string, panVatNo: string | null): Promise<unknown> {
  return inTx(scope.organizationId, (c) =>
    c.query(
      `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, pan_vat_no, address_line, address_city)
       VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', $4, 'Durbar Marg 1', 'Kathmandu')`,
      [id, scope.tenantId, `CUS-${id.slice(0, 8)}`, panVatNo],
    ),
  );
}

/** A lead of `scope`'s entity, at `stage`. */
function insertLead(scope: Scope, stage = 'new'): Promise<string> {
  return inTx(scope.organizationId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, company_name, contact_name, stage)
       VALUES ($1, $2, $3, 'Website rebuild', 'website', 'Acme', 'Sita', $4) RETURNING id`,
      [scope.tenantId, scope.organizationId, `LD-${randomUUID().slice(0, 8)}`, stage],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('lead insert returned no row');
    return id;
  });
}

/** An opportunity of `scope`'s entity for `customerId`, optionally from `leadId`, at `stage`. */
function insertOpportunity(
  scope: Scope,
  customerId: string,
  options: { leadId?: string; stage?: string } = {},
): Promise<string> {
  return inTx(scope.organizationId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id, lead_id, stage)
       VALUES ($1, $2, $3, 'Acme website', $4, $5, $6) RETURNING id`,
      [
        scope.tenantId,
        scope.organizationId,
        `DEAL-${randomUUID().slice(0, 8)}`,
        customerId,
        options.leadId ?? null,
        options.stage ?? 'qualified',
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('opportunity insert returned no row');
    return id;
  });
}

/** An activity of `scope`'s entity with the given subject columns. */
function insertActivity(
  scope: Scope,
  subjects: { leadId?: string; opportunityId?: string; customerId?: string },
): Promise<unknown> {
  return inTx(scope.organizationId, (c) =>
    c.query(
      `INSERT INTO app.activities (tenant_id, organization_id, kind, subject, lead_id, opportunity_id, customer_id)
       VALUES ($1, $2, 'call', 'Intro call', $3, $4, $5)`,
      [
        scope.tenantId,
        scope.organizationId,
        subjects.leadId ?? null,
        subjects.opportunityId ?? null,
        subjects.customerId ?? null,
      ],
    ),
  );
}

async function newScope(): Promise<Scope> {
  const { tenantId, organizationId } = await createTenantWithEntity(app);
  return { tenantId, organizationId };
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:crm-test'],
    ['bos.correlation_id', 'crm-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

describe('0015_crm on a fresh database', () => {
  it('applies, and creates the nine CRM tables', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...CRM_TABLES]],
    );
    expect(rows.filter((r) => r.oid === null).map((r) => r.name)).toEqual([]);
  });

  it('passes checkTenancy() with the strict defaults', async () => {
    const violations = await checkTenancy(owner);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('passes checkAudit()', async () => {
    await expect(checkAudit(owner)).resolves.toEqual([]);
  });

  it('records a customer write in the audit trail under the acting entity', async () => {
    const scope = await newScope();
    const customerId = await insertCustomer(scope);
    const { rows } = await owner.query<{ organization_id: string }>(
      `SELECT organization_id FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'customers' AND entity_id = $2`,
      [scope.tenantId, customerId],
    );
    expect(rows).toEqual([{ organization_id: scope.organizationId }]);
  });
});

describe('entity boundaries', () => {
  it('refuses an opportunity in entity A that names a lead of entity B (23503)', async () => {
    const a = await newScope();
    const b: Scope = { tenantId: a.tenantId, organizationId: await insertEntity(a.tenantId) };
    const customerId = await insertCustomer(a);
    const leadOfB = await insertLead(b);

    await expect(insertOpportunity(a, customerId, { leadId: leadOfB })).rejects.toMatchObject({
      code: '23503',
      constraint: 'opportunities_lead_fk',
    });
    // Control: the same lead from its own entity is accepted, and the customer is shared by both entities.
    await expect(insertOpportunity(b, customerId, { leadId: leadOfB })).resolves.toBeTypeOf(
      'string',
    );
  });

  it("refuses an opportunity whose customer is another tenant's (23503)", async () => {
    const a = await newScope();
    const other = await newScope();
    const foreignCustomer = await insertCustomer(other);
    await expect(insertOpportunity(a, foreignCustomer)).rejects.toMatchObject({
      code: '23503',
      constraint: 'opportunities_customer_fk',
    });
  });

  it('refuses a customer whose id is a vendor party (23503)', async () => {
    const scope = await newScope();
    const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'vendor' });
    await expect(insertCustomerRow(scope, partyId, null)).rejects.toMatchObject({
      code: '23503',
      constraint: 'customers_party_fk',
    });
  });
});

describe('activities have exactly one subject', () => {
  it('refuses zero subjects and two subjects (23514), and accepts one', async () => {
    const scope = await newScope();
    const customerId = await insertCustomer(scope);
    const leadId = await insertLead(scope);
    const failure = { code: '23514', constraint: 'activities_one_subject_check' };

    await expect(insertActivity(scope, {})).rejects.toMatchObject(failure);
    await expect(insertActivity(scope, { leadId, customerId })).rejects.toMatchObject(failure);
    await expect(insertActivity(scope, { leadId })).resolves.toBeDefined();
    await expect(insertActivity(scope, { customerId })).resolves.toBeDefined();
  });
});

describe('verification cases name their submitter', () => {
  it('refuses a submitted, approved or rejected case without submitter and time (23514)', async () => {
    const tenant = await createTenantWithEntity(app);
    const scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
    const { userId } = await createStaffUser(app, { ...scope, idpOrgId: tenant.idpOrgId });
    const insertCase = (status: string, submitted: boolean, decided: boolean) =>
      insertCustomer(scope).then((partyId) =>
        inTx(scope.organizationId, (c) =>
          c.query(
            `INSERT INTO app.verification_cases
               (tenant_id, party_id, status, submitted_by_user_id, submitted_at, reviewer_user_id, decided_at, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              scope.tenantId,
              partyId,
              status,
              submitted ? userId : null,
              submitted ? new Date() : null,
              decided ? userId : null,
              decided ? new Date() : null,
              status === 'rejected' ? 'no' : null,
            ],
          ),
        ),
      );
    const failure = { code: '23514', constraint: 'verification_cases_submission_check' };

    await expect(insertCase('submitted', false, false)).rejects.toMatchObject(failure);
    await expect(insertCase('approved', false, true)).rejects.toMatchObject(failure);
    await expect(insertCase('rejected', false, true)).rejects.toMatchObject(failure);
    await expect(insertCase('draft', false, false)).resolves.toBeDefined();
    await expect(insertCase('submitted', true, false)).resolves.toBeDefined();
    await expect(insertCase('approved', true, true)).resolves.toBeDefined();
  });
});

describe('PAN/VAT number', () => {
  it('is unique within a tenant (23505) and free across tenants', async () => {
    const a = await newScope();
    const b = await newScope();
    const pan = `6${randomUUID().replaceAll(/\D/g, '').slice(0, 8).padEnd(8, '0')}`;
    await insertCustomer(a, pan);

    await expect(insertCustomer(a, pan)).rejects.toMatchObject({
      code: '23505',
      constraint: 'customers_tenant_pan_vat_no_unique',
    });
    await expect(insertCustomer(b, pan)).resolves.toBeTypeOf('string');
    // Customers without a number do not collide.
    await insertCustomer(a, null);
    await expect(insertCustomer(a, null)).resolves.toBeTypeOf('string');
  });

  it('must be stored upper-case, so case cannot dodge the unique index (23514)', async () => {
    const scope = await newScope();
    await expect(insertCustomer(scope, 'abc-12345')).rejects.toMatchObject({
      code: '23514',
      constraint: 'customers_pan_vat_no_check',
    });
  });
});

describe('stage catalogue', () => {
  it('refuses a lead stage outside LEAD_STAGES (23514)', async () => {
    const scope = await newScope();
    // "engaged" was dropped from the pipeline (A2 C4).
    await expect(insertLead(scope, 'engaged')).rejects.toMatchObject({
      code: '23514',
      constraint: 'leads_stage_check',
    });
  });

  it('refuses an opportunity stage outside OPPORTUNITY_STAGES (23514)', async () => {
    const scope = await newScope();
    const customerId = await insertCustomer(scope);
    await expect(insertOpportunity(scope, customerId, { stage: 'prospect' })).rejects.toMatchObject(
      { code: '23514', constraint: 'opportunities_stage_check' },
    );
    await expect(
      insertOpportunity(scope, customerId, { stage: 'negotiation' }),
    ).resolves.toBeTypeOf('string');
  });
});
