// Integration tests for 0033_procurement_sourcing (P4 unit S-PR1) on a real, empty postgres:16-alpine started by
// Testcontainers (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/procurement.test.ts
//
// What 0033 must hold:
//   * the migrations apply on a fresh database, and the eight sourcing tables exist;
//   * checkTenancy() with its strict defaults and checkAudit() find nothing;
//   * a purchase request that is an emergency names its reason (AD12);
//   * a request's lines belong to its own entity, and are frozen once the request leaves draft or returned;
//   * a vendor can be invited to an RFQ only if it has a vendor account in the RFQ's entity (23503), and only an
//     invited vendor can quote;
//   * a quotation line prices a line of the RFQ's own purchase request, with a tax code of the tenant;
//   * the portal inbox keeps its states honest; a comparison score is bounded and one per criterion.
//
// Setup mirrors vendors.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app inside a transaction that names the acting entity (like withTx).
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
} from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const SOURCING_TABLES = [
  'purchase_requests',
  'purchase_request_lines',
  'rfqs',
  'rfq_vendors',
  'vendor_quotations',
  'vendor_quotation_lines',
  'vendor_quotation_submissions',
  'vendor_comparison_scores',
] as const;

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

/** One tenant with its default entity, two staff users, a department and a tax code. */
interface Scope {
  tenantId: string;
  organizationId: string;
  idpOrgId: string;
  userId: string;
  otherUserId: string;
  departmentId: string;
  taxCodeId: string;
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

/** Runs one statement in its own transaction under `organizationId`. */
function run(organizationId: string, sql: string, values: unknown[] = []): Promise<unknown> {
  return inTx(organizationId, (c) => c.query(sql, values));
}

/** Inserts one row and returns its id. */
async function insertReturningId(
  organizationId: string,
  sql: string,
  values: unknown[],
): Promise<string> {
  const { rows } = await inTx(organizationId, (c) => c.query<{ id: string }>(sql, values));
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('insert returned no row');
  return id;
}

async function newScope(): Promise<Scope> {
  const tenant = await createTenantWithEntity(app);
  const { tenantId, organizationId, idpOrgId } = tenant;
  const { userId } = await createStaffUser(app, { tenantId, organizationId, idpOrgId });
  const other = await createStaffUser(app, { tenantId, organizationId, idpOrgId });
  const { departmentId } = await createDepartment(app, { tenantId, organizationId });
  const taxCodeId = await insertReturningId(
    organizationId,
    `INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
     VALUES ($1, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2024-01-01') RETURNING id`,
    [tenantId],
  );
  return {
    tenantId,
    organizationId,
    idpOrgId,
    userId,
    otherUserId: other.userId,
    departmentId,
    taxCodeId,
  };
}

/** A second legal entity of the scope's tenant, with its own department. */
async function addEntity(scope: Scope): Promise<{ organizationId: string; departmentId: string }> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
     VALUES ($1, $2, $1, $3, $3, $3, false)`,
    [id, scope.tenantId, `E-${id}`],
  );
  const { departmentId } = await createDepartment(app, {
    tenantId: scope.tenantId,
    organizationId: id,
  });
  return { organizationId: id, departmentId };
}

/** A document of an entity (the quotation file). */
function insertDocument(tenantId: string, organizationId: string): Promise<string> {
  return insertReturningId(
    organizationId,
    `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
     VALUES ($1, $2, 'test_memo', $3) RETURNING id`,
    [tenantId, organizationId, randomUUID()],
  );
}

interface PrOptions {
  organizationId?: string;
  departmentId?: string;
  emergency?: boolean;
  reason?: string | null;
  number?: string | null;
}

/** A draft purchase request of an entity (the default entity unless told otherwise). */
async function insertPr(scope: Scope, options: PrOptions = {}): Promise<string> {
  const organizationId = options.organizationId ?? scope.organizationId;
  return insertReturningId(
    organizationId,
    `INSERT INTO app.purchase_requests
       (tenant_id, organization_id, number, request_type, department_id, requester_user_id, cost_center_id,
        justification, required_by, budget_code, currency, is_emergency, emergency_reason)
     VALUES ($1, $2, $3, 'goods', $4, $5, $6, 'Replace two failed switches', '2026-12-31', 'IT-2026',
             'NPR', $7, $8) RETURNING id`,
    [
      scope.tenantId,
      organizationId,
      options.number === undefined ? `PR-${randomUUID()}` : options.number,
      options.departmentId ?? scope.departmentId,
      scope.userId,
      (await createCostCenter(app, { tenantId: scope.tenantId, organizationId })).costCenterId,
      options.emergency ?? false,
      options.reason ?? null,
    ],
  );
}

/** A line of a purchase request: 2 x 1500.50 = 3001.00. */
function insertPrLine(
  scope: Scope,
  prId: string,
  lineNo: number,
  organizationId = scope.organizationId,
): Promise<string> {
  return insertReturningId(
    organizationId,
    `INSERT INTO app.purchase_request_lines
       (tenant_id, organization_id, purchase_request_id, line_no, description, uom, quantity,
        estimated_unit_price, estimated_amount)
     VALUES ($1, $2, $3, $4, '24-port switch', 'pcs', 2, 1500.50, 3001.00) RETURNING id`,
    [scope.tenantId, organizationId, prId, lineNo],
  );
}

/** Moves a purchase request to `status`. An NPR request, so its snapshot is rate 1. */
function setPrStatus(scope: Scope, prId: string, status: string): Promise<unknown> {
  return run(
    scope.organizationId,
    `UPDATE app.purchase_requests
        SET status = $3, estimated_total = 3001.00, fx_rate = 1, estimated_total_npr = 3001.00
      WHERE tenant_id = $1 AND id = $2`,
    [scope.tenantId, prId, status],
  );
}

/** A nine-digit Nepali PAN that no other test uses. */
function newPan(): string {
  return randomUUID().replaceAll(/\D/g, '').padEnd(9, '7').slice(0, 9);
}

/** A vendor party and its vendor row (tenant-level). */
async function insertVendor(scope: Scope): Promise<string> {
  const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'vendor' });
  await run(
    scope.organizationId,
    `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, pan, country, created_by)
     VALUES ($1, $2, 'Himal Supplies Pvt. Ltd.', 'company', $3, 'NP', $4)`,
    [partyId, scope.tenantId, newPan(), scope.userId],
  );
  return partyId;
}

/** A vendor account: the vendor's terms with one entity. */
function insertVendorAccount(
  scope: Scope,
  vendorId: string,
  organizationId: string,
): Promise<unknown> {
  return run(
    organizationId,
    `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_currency)
     VALUES ($1, $2, $3, 'NPR')`,
    [scope.tenantId, organizationId, vendorId],
  );
}

function insertRfq(
  scope: Scope,
  prId: string,
  organizationId = scope.organizationId,
): Promise<string> {
  return insertReturningId(
    organizationId,
    `INSERT INTO app.rfqs (tenant_id, organization_id, purchase_request_id, number, deadline, created_by)
     VALUES ($1, $2, $3, $4, now() + interval '7 days', $5) RETURNING id`,
    [scope.tenantId, organizationId, prId, `RFQ-${randomUUID()}`, scope.userId],
  );
}

function inviteVendor(
  scope: Scope,
  rfqId: string,
  vendorId: string,
  organizationId = scope.organizationId,
): Promise<string> {
  return insertReturningId(
    organizationId,
    `INSERT INTO app.rfq_vendors (tenant_id, organization_id, rfq_id, vendor_id, invited_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [scope.tenantId, organizationId, rfqId, vendorId, scope.userId],
  );
}

interface QuotationOptions {
  prId?: string;
  total?: string;
  totalNpr?: string;
  currency?: string;
  fxRate?: string;
}

/** A quotation of 3001.00 + 390.13 tax, recorded against an invited vendor. */
async function insertQuotation(
  scope: Scope,
  rfqId: string,
  prId: string,
  vendorId: string,
  options: QuotationOptions = {},
): Promise<string> {
  const documentId = await insertDocument(scope.tenantId, scope.organizationId);
  const foreign = options.currency !== undefined && options.currency !== 'NPR';
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.vendor_quotations
       (tenant_id, organization_id, rfq_id, purchase_request_id, vendor_id, valid_until, currency, subtotal,
        tax_amount, total, fx_rate, fx_source, fx_date, total_npr, document_id, recorded_by)
     VALUES ($1, $2, $3, $4, $5, '2026-12-31', $6, 3001.00, 390.13, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      rfqId,
      options.prId ?? prId,
      vendorId,
      options.currency ?? 'NPR',
      options.total ?? '3391.13',
      options.fxRate ?? '1',
      foreign ? 'nrb' : null,
      foreign ? '2026-11-01' : null,
      options.totalNpr ?? '3391.13',
      documentId,
      scope.userId,
    ],
  );
}

function insertQuotationLine(
  scope: Scope,
  quotationId: string,
  prId: string,
  prLineId: string,
  taxCodeId = scope.taxCodeId,
): Promise<string> {
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.vendor_quotation_lines
       (tenant_id, organization_id, vendor_quotation_id, purchase_request_id, pr_line_id, description, quantity,
        unit_price, tax_code_id, gross, tax_amount, line_total)
     VALUES ($1, $2, $3, $4, $5, 'Laptop', 2, 1500.50, $6, 3001.00, 390.13, 3391.13) RETURNING id`,
    [scope.tenantId, scope.organizationId, quotationId, prId, prLineId, taxCodeId],
  );
}

/** A request with one line, an RFQ, an invited vendor and its quotation: the whole sourcing chain. */
async function sourcingChain(scope: Scope) {
  const prId = await insertPr(scope);
  const prLineId = await insertPrLine(scope, prId, 1);
  const rfqId = await insertRfq(scope, prId);
  const vendorId = await insertVendor(scope);
  await insertVendorAccount(scope, vendorId, scope.organizationId);
  await inviteVendor(scope, rfqId, vendorId);
  const quotationId = await insertQuotation(scope, rfqId, prId, vendorId);
  return { prId, prLineId, rfqId, vendorId, quotationId };
}

/** An inbox upload of `vendorId` into the scope's default entity. */
async function insertSubmission(scope: Scope, vendorId: string): Promise<string> {
  const documentId = await insertDocument(scope.tenantId, scope.organizationId);
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.vendor_quotation_submissions
       (tenant_id, organization_id, vendor_id, submitted_by, document_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [scope.tenantId, scope.organizationId, vendorId, scope.userId, documentId],
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:procurement-test'],
    ['bos.correlation_id', 'procurement-test-0001'],
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

describe('0033_procurement_sourcing on a fresh database', () => {
  it('applies, and creates the eight sourcing tables', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...SOURCING_TABLES]],
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

  it('records a purchase request write in the audit trail under its entity', async () => {
    const scope = await newScope();
    const prId = await insertPr(scope);
    const { rows } = await owner.query<{ organization_id: string }>(
      `SELECT organization_id FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'purchase_requests' AND entity_id = $2`,
      [scope.tenantId, prId],
    );
    expect(rows).toEqual([{ organization_id: scope.organizationId }]);
  });
});

describe('an emergency purchase request names its reason (AD12)', () => {
  it('refuses an emergency with no reason, or a blank one (23514)', async () => {
    const scope = await newScope();
    const failure = { code: '23514', constraint: 'purchase_requests_emergency_reason_check' };
    await expect(insertPr(scope, { emergency: true })).rejects.toMatchObject(failure);
    await expect(insertPr(scope, { emergency: true, reason: '   ' })).rejects.toMatchObject(
      failure,
    );
  });

  it('accepts an emergency with a reason, and an ordinary request with none', async () => {
    const scope = await newScope();
    await expect(
      insertPr(scope, { emergency: true, reason: 'Core switch down, site offline' }),
    ).resolves.toBeTypeOf('string');
    await expect(insertPr(scope)).resolves.toBeTypeOf('string');
  });
});

describe('purchase requests and their lines', () => {
  it('refuses a department of another entity (23503) and a number used twice (23505)', async () => {
    const scope = await newScope();
    const other = await addEntity(scope);
    await expect(insertPr(scope, { departmentId: other.departmentId })).rejects.toMatchObject({
      code: '23503',
      constraint: 'purchase_requests_department_fk',
    });
    await insertPr(scope, { number: 'PR-2026-0001' });
    await expect(insertPr(scope, { number: 'PR-2026-0001' })).rejects.toMatchObject({
      code: '23505',
      constraint: 'purchase_requests_tenant_org_number_unique',
    });
    // The same number is free in another entity, and requests with no number yet do not collide.
    await expect(
      insertPr(scope, {
        organizationId: other.organizationId,
        departmentId: other.departmentId,
        number: 'PR-2026-0001',
      }),
    ).resolves.toBeTypeOf('string');
    await insertPr(scope, { number: null });
    await expect(insertPr(scope, { number: null })).resolves.toBeTypeOf('string');
  });

  it('refuses a line whose request is in another entity (23503)', async () => {
    const scope = await newScope();
    const other = await addEntity(scope);
    const prId = await insertPr(scope);
    await expect(insertPrLine(scope, prId, 1, other.organizationId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'purchase_request_lines_purchase_request_fk',
    });
  });

  it('refuses a submitted request with no FX snapshot (23514)', async () => {
    const scope = await newScope();
    const prId = await insertPr(scope);
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.purchase_requests SET status = 'submitted' WHERE id = $1`,
        [prId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'purchase_requests_snapshot_check' });
  });

  it('freezes the lines once the request is submitted, and thaws them when it is returned', async () => {
    const scope = await newScope();
    const prId = await insertPr(scope);
    const lineId = await insertPrLine(scope, prId, 1);
    // Control: edits are open while the request is a draft.
    await insertPrLine(scope, prId, 2);
    await run(
      scope.organizationId,
      `UPDATE app.purchase_request_lines SET quantity = 3, estimated_amount = 4501.50 WHERE id = $1`,
      [lineId],
    );

    await setPrStatus(scope, prId, 'submitted');
    const frozen = { code: '23514', constraint: 'purchase_request_lines_frozen_check' };
    await expect(insertPrLine(scope, prId, 3)).rejects.toMatchObject(frozen);
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.purchase_request_lines SET description = 'changed' WHERE id = $1`,
        [lineId],
      ),
    ).rejects.toMatchObject(frozen);
    await expect(
      run(scope.organizationId, `DELETE FROM app.purchase_request_lines WHERE id = $1`, [lineId]),
    ).rejects.toMatchObject(frozen);

    // The approver sends it back: the requester may edit again.
    await setPrStatus(scope, prId, 'returned');
    await expect(insertPrLine(scope, prId, 3)).resolves.toBeTypeOf('string');
    await setPrStatus(scope, prId, 'submitted');
    await setPrStatus(scope, prId, 'dept_approved');
    await expect(insertPrLine(scope, prId, 4)).rejects.toMatchObject(frozen);
  });
});

describe('an RFQ invites only vendors with an account in its entity', () => {
  it('refuses a cross-entity vendor (23503), and accepts the same vendor in its own entity', async () => {
    const scope = await newScope();
    const other = await addEntity(scope);
    const vendorId = await insertVendor(scope);
    // The vendor trades with the default entity only.
    await insertVendorAccount(scope, vendorId, scope.organizationId);

    const prB = await insertPr(scope, {
      organizationId: other.organizationId,
      departmentId: other.departmentId,
    });
    const rfqB = await insertRfq(scope, prB, other.organizationId);
    await expect(inviteVendor(scope, rfqB, vendorId, other.organizationId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'rfq_vendors_vendor_account_fk',
    });

    // Control: the same vendor is invited to an RFQ of the entity it has an account in.
    const prA = await insertPr(scope);
    const rfqA = await insertRfq(scope, prA);
    await expect(inviteVendor(scope, rfqA, vendorId)).resolves.toBeTypeOf('string');
  });

  it('refuses a vendor with no account anywhere (23503) and a second invitation (23505)', async () => {
    const scope = await newScope();
    const prId = await insertPr(scope);
    const rfqId = await insertRfq(scope, prId);
    const stranger = await insertVendor(scope);
    await expect(inviteVendor(scope, rfqId, stranger)).rejects.toMatchObject({
      code: '23503',
      constraint: 'rfq_vendors_vendor_account_fk',
    });
    const vendorId = await insertVendor(scope);
    await insertVendorAccount(scope, vendorId, scope.organizationId);
    await inviteVendor(scope, rfqId, vendorId);
    await expect(inviteVendor(scope, rfqId, vendorId)).rejects.toMatchObject({
      code: '23505',
      constraint: 'rfq_vendors_tenant_org_rfq_vendor_unique',
    });
  });

  it('allows one live RFQ per purchase request, and a new one after a cancel (23505)', async () => {
    const scope = await newScope();
    const prId = await insertPr(scope);
    const first = await insertRfq(scope, prId);
    await expect(insertRfq(scope, prId)).rejects.toMatchObject({
      code: '23505',
      constraint: 'rfqs_tenant_purchase_request_live_unique',
    });
    await run(scope.organizationId, `UPDATE app.rfqs SET status = 'cancelled' WHERE id = $1`, [
      first,
    ]);
    await expect(insertRfq(scope, prId)).resolves.toBeTypeOf('string');
  });

  it('refuses an RFQ whose purchase request is in another entity (23503)', async () => {
    const scope = await newScope();
    const other = await addEntity(scope);
    const prId = await insertPr(scope);
    await expect(insertRfq(scope, prId, other.organizationId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'rfqs_purchase_request_fk',
    });
  });
});

describe('vendor quotations', () => {
  it('refuses a quotation from a vendor that was not invited (23503)', async () => {
    const scope = await newScope();
    const prId = await insertPr(scope);
    const rfqId = await insertRfq(scope, prId);
    const vendorId = await insertVendor(scope);
    await insertVendorAccount(scope, vendorId, scope.organizationId);
    await expect(insertQuotation(scope, rfqId, prId, vendorId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_quotations_rfq_vendor_fk',
    });
    await inviteVendor(scope, rfqId, vendorId);
    await expect(insertQuotation(scope, rfqId, prId, vendorId)).resolves.toBeTypeOf('string');
  });

  it("refuses a quotation naming another request than its RFQ's (23503)", async () => {
    const scope = await newScope();
    const prId = await insertPr(scope);
    const rfqId = await insertRfq(scope, prId);
    const vendorId = await insertVendor(scope);
    await insertVendorAccount(scope, vendorId, scope.organizationId);
    await inviteVendor(scope, rfqId, vendorId);
    const otherPr = await insertPr(scope);
    await expect(
      insertQuotation(scope, rfqId, prId, vendorId, { prId: otherPr }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'vendor_quotations_rfq_fk' });
    await expect(insertQuotation(scope, rfqId, prId, vendorId)).resolves.toBeTypeOf('string');
  });

  it('allows one quotation per vendor per RFQ (23505)', async () => {
    const scope = await newScope();
    const { prId, rfqId, vendorId } = await sourcingChain(scope);
    await expect(insertQuotation(scope, rfqId, prId, vendorId)).rejects.toMatchObject({
      code: '23505',
      constraint: 'vendor_quotations_tenant_org_rfq_vendor_unique',
    });
  });

  it('keeps the totals and the NPR snapshot honest (23514)', async () => {
    const scope = await newScope();
    const prId = await insertPr(scope);
    const rfqId = await insertRfq(scope, prId);
    const vendorId = await insertVendor(scope);
    await insertVendorAccount(scope, vendorId, scope.organizationId);
    await inviteVendor(scope, rfqId, vendorId);
    // An NPR total equals its NPR amount, at rate 1.
    await expect(
      insertQuotation(scope, rfqId, prId, vendorId, { totalNpr: '3000.00' }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'vendor_quotations_npr_snapshot_check' });
    // The total is the subtotal plus the tax.
    await expect(
      insertQuotation(scope, rfqId, prId, vendorId, { total: '3000.00', totalNpr: '3000.00' }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'vendor_quotations_total_check' });
    // A USD quotation carries its rate, source and date; the service rounds its NPR amount.
    await expect(
      insertQuotation(scope, rfqId, prId, vendorId, {
        currency: 'USD',
        fxRate: '134.500000',
        totalNpr: '456073.99',
      }),
    ).resolves.toBeTypeOf('string');
  });

  it('prices only a line of its own request (23503), with a tax code of its tenant (23503), once (23505)', async () => {
    const scope = await newScope();
    const { prId, prLineId, quotationId } = await sourcingChain(scope);
    const otherPr = await insertPr(scope);
    const otherLine = await insertPrLine(scope, otherPr, 1);
    await expect(insertQuotationLine(scope, quotationId, prId, otherLine)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_quotation_lines_pr_line_fk',
    });

    const foreign = await newScope();
    await expect(
      insertQuotationLine(scope, quotationId, prId, prLineId, foreign.taxCodeId),
    ).rejects.toMatchObject({ code: '23503', constraint: 'vendor_quotation_lines_tax_code_fk' });

    await expect(insertQuotationLine(scope, quotationId, prId, prLineId)).resolves.toBeTypeOf(
      'string',
    );
    await expect(insertQuotationLine(scope, quotationId, prId, prLineId)).rejects.toMatchObject({
      code: '23505',
      constraint: 'vendor_quotation_lines_tenant_quotation_pr_line_unique',
    });
  });

  it('lets an RFQ recommend only one of its own quotations (23503), with a rationale (23514)', async () => {
    const scope = await newScope();
    const mine = await sourcingChain(scope);
    const theirs = await sourcingChain(scope);
    await run(scope.organizationId, `UPDATE app.rfqs SET status = 'closed' WHERE id = $1`, [
      mine.rfqId,
    ]);
    const recommend = (quotationId: string) =>
      run(
        scope.organizationId,
        `UPDATE app.rfqs
            SET status = 'recommended', recommended_quotation_id = $2, recommendation_rationale = 'Lowest total'
          WHERE id = $1`,
        [mine.rfqId, quotationId],
      );
    await expect(recommend(theirs.quotationId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'rfqs_recommended_quotation_fk',
    });
    await expect(recommend(mine.quotationId)).resolves.toBeDefined();
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.rfqs SET recommendation_rationale = NULL WHERE id = $1`,
        [mine.rfqId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'rfqs_recommended_check' });
  });
});

describe('the portal inbox and the comparison scores', () => {
  it('converts a submission only with a reviewer and a quotation of the same vendor', async () => {
    const scope = await newScope();
    const { vendorId, quotationId } = await sourcingChain(scope);
    const submissionId = await insertSubmission(scope, vendorId);
    const update = (set: string, ...values: unknown[]) =>
      run(
        scope.organizationId,
        `UPDATE app.vendor_quotation_submissions SET ${set} WHERE id = $1`,
        [submissionId, ...values],
      );
    await expect(
      update(`status = 'converted', reviewed_by = $2`, scope.otherUserId),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_quotation_submissions_converted_check',
    });
    await expect(
      update(`status = 'rejected', reviewed_by = $2`, scope.otherUserId),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_quotation_submissions_rejected_check',
    });
    await expect(update(`status = 'archived'`)).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_quotation_submissions_status_check',
    });
    // A quotation of another vendor is not this vendor's conversion.
    const rival = await sourcingChain(scope);
    await expect(
      update(
        `status = 'converted', reviewed_by = $2, converted_quotation_id = $3`,
        scope.otherUserId,
        rival.quotationId,
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_quotation_submissions_converted_quotation_fk',
    });
    await expect(
      update(
        `status = 'converted', reviewed_by = $2, converted_quotation_id = $3`,
        scope.otherUserId,
        quotationId,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses an upload from a vendor with no account in the entity (23503)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope);
    await expect(insertSubmission(scope, vendorId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_quotation_submissions_vendor_account_fk',
    });
  });

  it('bounds a score to 0..100 and allows one score per criterion (23514, 23505)', async () => {
    const scope = await newScope();
    const { quotationId } = await sourcingChain(scope);
    const score = (criterion: string, value: string) =>
      insertReturningId(
        scope.organizationId,
        `INSERT INTO app.vendor_comparison_scores
           (tenant_id, organization_id, vendor_quotation_id, criterion, score, scored_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [scope.tenantId, scope.organizationId, quotationId, criterion, value, scope.userId],
      );
    await expect(score('price', '100.01')).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_comparison_scores_score_check',
    });
    await expect(score('price', '82.50')).resolves.toBeTypeOf('string');
    await expect(score('price', '90.00')).rejects.toMatchObject({
      code: '23505',
      constraint: 'vendor_comparison_scores_tenant_quotation_criterion_unique',
    });
    await expect(score('delivery', '70')).resolves.toBeTypeOf('string');
  });
});
