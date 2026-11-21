// Integration tests for 0035_payables (P4 unit S-AP) on a real, empty postgres:16-alpine started by Testcontainers
// (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/payables.test.ts
//
// What 0035 must hold (P4 done checks 8, 9, 10 and 12, at the schema level):
//   * the migrations apply on a fresh database, and the seven payables tables and the progress view exist;
//   * checkTenancy() with its strict defaults and checkAudit() find nothing;
//   * a bill's invoice number is normalised, and INV-001 / inv 001 / INV/001 of one vendor, entity and fiscal year
//     collide (23505, check 8);
//   * payable = net + vat - tds is a CHECK;
//   * a bill line cannot link to a PO line of another entity or another PO (23503, check 12);
//   * a payment request line has amount > 0 and points at an open item of its entity;
//   * vendor_accounts.default_withholding_code_id now references withholding_codes of the same tenant;
//   * a match exception is never decided by the user who asked for it;
//   * no P4 table has a paid or balance column (check 10's grep);
//   * v_po_line_progress gives ordered, cancelled, received (confirmed, net of reversals) and billed per PO line.
//
// Setup mirrors procurement-orders.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate
// as bos_owner, write as bos_app inside a transaction that names the acting entity (like withTx). POs here are
// raised without an RFQ (purchase_orders_source_check allows both NULL), which is enough for the payables links.
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

const PAYABLES_TABLES = [
  'vendor_bill_submissions',
  'vendor_bills',
  'vendor_bill_lines',
  'match_results',
  'match_exceptions',
  'payment_requests',
  'payment_request_lines',
] as const;

/** Every relation P4 created (0032-0035), for check 10's grep. */
const P4_RELATIONS = [
  'vendors',
  'vendor_contacts',
  'vendor_bank_accounts',
  'vendor_accounts',
  'purchase_requests',
  'purchase_request_lines',
  'rfqs',
  'rfq_vendors',
  'vendor_quotations',
  'vendor_quotation_lines',
  'vendor_quotation_submissions',
  'purchase_orders',
  'purchase_order_versions',
  'purchase_order_lines',
  'receipts',
  'receipt_lines',
  'receipt_serials',
  'vendor_comparison_scores',
  ...PAYABLES_TABLES,
  'v_po_line_progress',
] as const;

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

/** One tenant with its default entity, two staff users, a department and a tax code. */
interface Scope {
  tenantId: string;
  organizationId: string;
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

function run(organizationId: string, sql: string, values: unknown[] = []): Promise<unknown> {
  return inTx(organizationId, (c) => c.query(sql, values));
}

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
  const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(app);
  const { userId } = await createStaffUser(app, { tenantId, organizationId, idpOrgId });
  const other = await createStaffUser(app, { tenantId, organizationId, idpOrgId });
  const { departmentId } = await createDepartment(app, { tenantId, organizationId });
  const taxCodeId = await insertReturningId(
    organizationId,
    `INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
     VALUES ($1, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2024-01-01') RETURNING id`,
    [tenantId],
  );
  return { tenantId, organizationId, userId, otherUserId: other.userId, departmentId, taxCodeId };
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

function insertDocument(scope: Scope, organizationId = scope.organizationId): Promise<string> {
  return insertReturningId(
    organizationId,
    `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
     VALUES ($1, $2, 'test_memo', $3) RETURNING id`,
    [scope.tenantId, organizationId, randomUUID()],
  );
}

function newPan(): string {
  return randomUUID().replaceAll(/\D/g, '').padEnd(9, '7').slice(0, 9);
}

/** A vendor party and its vendor row, with an account in each entity given. */
async function insertVendor(scope: Scope, organizationIds: string[]): Promise<string> {
  const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'vendor' });
  await run(
    scope.organizationId,
    `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, pan, country, created_by)
     VALUES ($1, $2, 'Himal Supplies Pvt. Ltd.', 'company', $3, 'NP', $4)`,
    [partyId, scope.tenantId, newPan(), scope.userId],
  );
  for (const organizationId of organizationIds) {
    await run(
      organizationId,
      `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_currency)
       VALUES ($1, $2, $3, 'NPR')`,
      [scope.tenantId, organizationId, partyId],
    );
  }
  return partyId;
}

let counter = 0;
const nextSeq = () => ++counter;

/** A draft PO (no RFQ) of one entity for the vendor, with one goods line of `quantity` at 100.00 (13% tax). */
async function orderOf(
  scope: Scope,
  vendorId: string,
  entity: { organizationId: string; departmentId: string },
  quantity = '5',
  cancelled = '0',
): Promise<{ poId: string; poLineId: string }> {
  const { organizationId } = entity;
  const prId = await insertReturningId(
    organizationId,
    `INSERT INTO app.purchase_requests
       (tenant_id, organization_id, number, request_type, department_id, requester_user_id, cost_center_id,
        justification, required_by, budget_code, currency, is_emergency)
     VALUES ($1, $2, $3, 'goods', $4, $5, $6, 'Replace two failed switches', '2026-12-31', 'IT-2026', 'NPR', false)
     RETURNING id`,
    [
      scope.tenantId,
      organizationId,
      `PR-${randomUUID()}`,
      entity.departmentId,
      scope.userId,
      (await createCostCenter(app, { tenantId: scope.tenantId, organizationId })).costCenterId,
    ],
  );
  const seq = nextSeq();
  const poId = await insertReturningId(
    organizationId,
    `INSERT INTO app.purchase_orders
       (tenant_id, organization_id, number, number_seq, fiscal_year, purchase_request_id, vendor_id, currency,
        payment_terms_days, approved_total, fx_rate, approved_total_npr, approved_band, created_by)
     VALUES ($1, $2, $3, $4, '2083/84', $5, $6, 'NPR', 30, 565.00, 1, 565.00, 'base', $7) RETURNING id`,
    [scope.tenantId, organizationId, `PO-${seq}`, seq, prId, vendorId, scope.userId],
  );
  const q = Number(quantity);
  const poLineId = await insertReturningId(
    organizationId,
    `INSERT INTO app.purchase_order_lines
       (tenant_id, organization_id, purchase_order_id, purchase_request_id, line_no, kind, description, uom,
        ordered_quantity, cancelled_quantity, unit_price, tax_code_id, gross, tax_amount, line_total)
     VALUES ($1, $2, $3, $4, 1, 'goods', '24-port switch', 'pcs', $5, $6, 100.00, $7, $8, $9, $10) RETURNING id`,
    [
      scope.tenantId,
      organizationId,
      poId,
      prId,
      quantity,
      cancelled,
      scope.taxCodeId,
      (q * 100).toFixed(2),
      (q * 13).toFixed(2),
      (q * 113).toFixed(2),
    ],
  );
  return { poId, poLineId };
}

/** A receipt of a PO (confirmed unless told otherwise) with one line of `quantity` on the PO line. */
async function receive(
  scope: Scope,
  poId: string,
  poLineId: string,
  quantity: string,
  status = 'confirmed',
): Promise<string> {
  const seq = nextSeq();
  const receiptId = await insertReturningId(
    scope.organizationId,
    `INSERT INTO app.receipts
       (tenant_id, organization_id, number, number_seq, fiscal_year, purchase_order_id, kind, received_at, status,
        created_by, confirmed_by, confirmed_at)
     VALUES ($1, $2, $3, $4, '2083/84', $5, 'goods', '2026-11-05', $6, $7, $8, $9) RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      `GRN-${seq}`,
      seq,
      poId,
      status,
      scope.userId,
      status === 'draft' ? null : scope.userId,
      status === 'draft' ? null : new Date().toISOString(),
    ],
  );
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.receipt_lines (tenant_id, organization_id, receipt_id, purchase_order_id, po_line_id, line_no, quantity)
     VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`,
    [scope.tenantId, scope.organizationId, receiptId, poId, poLineId, quantity],
  );
}

interface BillOptions {
  invoiceNo?: string;
  fiscalYear?: string;
  poId?: string | null;
  status?: string;
  net?: string;
  vat?: string;
  tds?: string;
  payable?: string;
  withholdingCodeId?: string | null;
}

/** A vendor bill of 500.00 + 65.00 VAT = 565.00 (NPR), in the scope's default entity. */
async function insertBill(
  scope: Scope,
  vendorId: string,
  options: BillOptions = {},
): Promise<string> {
  const documentId = await insertDocument(scope);
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.vendor_bills
       (tenant_id, organization_id, kind, vendor_id, vendor_invoice_no, invoice_date, fiscal_year, currency,
        purchase_order_id, document_id, status, net_total, vat_total, tds_total, payable_total, withholding_code_id,
        fx_rate, payable_total_npr, entered_by)
     VALUES ($1, $2, 'bill', $3, $4, '2026-11-06', $5, 'NPR', $6, $7, $8, $9, $10, $11, $12, $13, 1, $12, $14)
     RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      vendorId,
      options.invoiceNo ?? `INV-${randomUUID()}`,
      options.fiscalYear ?? '2083/84',
      options.poId ?? null,
      documentId,
      options.status ?? 'draft',
      options.net ?? '500.00',
      options.vat ?? '65.00',
      options.tds ?? '0.00',
      options.payable ?? '565.00',
      options.withholdingCodeId ?? null,
      scope.userId,
    ],
  );
}

interface BillLineOptions {
  poId?: string | null;
  poLineId?: string | null;
  receiptLineId?: string | null;
  quantity?: string;
  lineNo?: number;
}

/** A bill line of `quantity` at 100.00 with 13% VAT. */
function insertBillLine(
  scope: Scope,
  billId: string,
  options: BillLineOptions = {},
): Promise<string> {
  const q = Number(options.quantity ?? '5');
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.vendor_bill_lines
       (tenant_id, organization_id, vendor_bill_id, purchase_order_id, po_line_id, receipt_line_id, line_no,
        description, account_id, quantity, unit_price, net_amount, tax_code_id, vat_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '24-port switch', $8, $9, 100.00, $10, $11, $12) RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      billId,
      options.poId ?? null,
      options.poLineId ?? null,
      options.receiptLineId ?? null,
      options.lineNo ?? 1,
      randomUUID(),
      String(q),
      (q * 100).toFixed(2),
      scope.taxCodeId,
      (q * 13).toFixed(2),
    ],
  );
}

function insertWithholdingCode(tenantId: string, organizationId: string): Promise<string> {
  return insertReturningId(
    organizationId,
    `INSERT INTO app.withholding_codes (tenant_id, code, name, applies_to, rate_bp, effective_from)
     VALUES ($1, $2, 'TDS services', 'payable', 0, '2024-01-01') RETURNING id`,
    [tenantId, `TDS-${randomUUID()}`],
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:payables-test'],
    ['bos.correlation_id', 'payables-test-0001'],
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

describe('0035_payables on a fresh database', () => {
  it('applies, and creates the seven payables tables and the progress view', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...PAYABLES_TABLES, 'v_po_line_progress']],
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

  it('has no paid or balance column in any P4 table or view (check 10)', async () => {
    const { rows } = await owner.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = ANY($1::text[])`,
      [[...P4_RELATIONS]],
    );
    // Every listed relation answered, so a typo cannot make the grep pass on nothing.
    expect([...new Set(rows.map((r) => r.table_name))].sort()).toEqual([...P4_RELATIONS].sort());
    expect(rows.filter((r) => /paid|balance/.test(r.column_name))).toEqual([]);
  });
});

describe('vendor_accounts.default_withholding_code_id', () => {
  it('references a withholding code of the same tenant (23503 otherwise)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const set = (codeId: string) =>
      run(
        scope.organizationId,
        `UPDATE app.vendor_accounts SET default_withholding_code_id = $3
          WHERE tenant_id = $1 AND vendor_id = $2`,
        [scope.tenantId, vendorId, codeId],
      );
    await expect(set(randomUUID())).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_accounts_default_withholding_code_fk',
    });
    const stranger = await newScope();
    const foreignCode = await insertWithholdingCode(stranger.tenantId, stranger.organizationId);
    await expect(set(foreignCode)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_accounts_default_withholding_code_fk',
    });
    const code = await insertWithholdingCode(scope.tenantId, scope.organizationId);
    await set(code);
    const { rows } = await owner.query<{ id: string }>(
      `SELECT default_withholding_code_id AS id FROM app.vendor_accounts WHERE tenant_id = $1 AND vendor_id = $2`,
      [scope.tenantId, vendorId],
    );
    expect(rows).toEqual([{ id: code }]);
  });
});

describe('vendor_bills', () => {
  it('normalises the invoice number and refuses INV-001 / inv 001 / INV/001 again (check 8, 23505)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const first = await insertBill(scope, vendorId, { invoiceNo: 'INV-001' });
    const { rows } = await owner.query<{ norm: string }>(
      `SELECT invoice_no_norm AS norm FROM app.vendor_bills WHERE id = $1`,
      [first],
    );
    expect(rows).toEqual([{ norm: 'INV001' }]);
    for (const invoiceNo of ['inv 001', 'INV/001', ' i-n-v 0 0 1 ']) {
      await expect(insertBill(scope, vendorId, { invoiceNo })).rejects.toMatchObject({
        code: '23505',
        constraint: 'vendor_bills_tenant_org_vendor_invoice_fy_unique',
      });
    }
  });

  it('allows the same invoice number from another vendor or in another fiscal year', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const rival = await insertVendor(scope, [scope.organizationId]);
    await insertBill(scope, vendorId, { invoiceNo: 'INV-001' });
    await expect(insertBill(scope, rival, { invoiceNo: 'INV-001' })).resolves.toBeTypeOf('string');
    await expect(
      insertBill(scope, vendorId, { invoiceNo: 'INV-001', fiscalYear: '2084/85' }),
    ).resolves.toBeTypeOf('string');
  });

  it('holds payable = net + vat - tds (23514)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    await expect(insertBill(scope, vendorId, { payable: '565.01' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_bills_payable_check',
    });
    const code = await insertWithholdingCode(scope.tenantId, scope.organizationId);
    // 100,000 + 13,000 - 1,500 = 111,500 (done check 16).
    await expect(
      insertBill(scope, vendorId, {
        net: '100000.00',
        vat: '13000.00',
        tds: '1500.00',
        payable: '111500.00',
        withholdingCodeId: code,
      }),
    ).resolves.toBeTypeOf('string');
  });

  it('refuses a vendor with no account in the bill entity, and a PO of another vendor (23503)', async () => {
    const scope = await newScope();
    const other = await addEntity(scope);
    const outsider = await insertVendor(scope, [other.organizationId]);
    await expect(insertBill(scope, outsider)).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_bills_vendor_account_fk',
    });
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const rival = await insertVendor(scope, [scope.organizationId]);
    const { poId } = await orderOf(scope, rival, scope);
    await expect(insertBill(scope, vendorId, { poId })).rejects.toMatchObject({
      code: '23503',
      constraint: 'vendor_bills_purchase_order_fk',
    });
  });

  it('allows a non-PO bill with lines that link to no PO', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const billId = await insertBill(scope, vendorId);
    await expect(insertBillLine(scope, billId)).resolves.toBeTypeOf('string');
  });
});

describe('vendor_bill_lines link only inside their entity and PO', () => {
  it('refuses a PO line of another entity (check 12, 23503)', async () => {
    const scope = await newScope();
    const other = await addEntity(scope);
    const vendorId = await insertVendor(scope, [scope.organizationId, other.organizationId]);
    const own = await orderOf(scope, vendorId, scope);
    const foreign = await orderOf(scope, vendorId, other);
    const billId = await insertBill(scope, vendorId, { poId: own.poId });
    await expect(
      insertBillLine(scope, billId, { poId: own.poId, poLineId: foreign.poLineId }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'vendor_bill_lines_po_line_fk' });
    await expect(
      insertBillLine(scope, billId, { poId: own.poId, poLineId: own.poLineId }),
    ).resolves.toBeTypeOf('string');
  });

  it('refuses a PO other than the bill PO, a receipt line of another PO line, and a PO line without its PO', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const first = await orderOf(scope, vendorId, scope);
    const second = await orderOf(scope, vendorId, scope);
    const billId = await insertBill(scope, vendorId, { poId: first.poId });
    await expect(
      insertBillLine(scope, billId, { poId: second.poId, poLineId: second.poLineId }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'vendor_bill_lines_bill_po_fk' });
    const receiptLineOfSecond = await receive(scope, second.poId, second.poLineId, '1');
    await expect(
      insertBillLine(scope, billId, {
        poId: first.poId,
        poLineId: first.poLineId,
        receiptLineId: receiptLineOfSecond,
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'vendor_bill_lines_receipt_line_fk' });
    await expect(insertBillLine(scope, billId, { poLineId: first.poLineId })).rejects.toMatchObject(
      { code: '23514', constraint: 'vendor_bill_lines_po_link_check' },
    );
  });
});

describe('match_exceptions', () => {
  it('is never decided by the user who asked for it (23514)', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const billId = await insertBill(scope, vendorId, { status: 'variance' });
    const decide = (decidedBy: string) =>
      insertReturningId(
        scope.organizationId,
        `INSERT INTO app.match_exceptions
           (tenant_id, organization_id, vendor_bill_id, reason, status, requested_by, decided_by, decided_at)
         VALUES ($1, $2, $3, 'Freight was agreed by phone', 'approved', $4, $5, now()) RETURNING id`,
        [scope.tenantId, scope.organizationId, billId, scope.userId, decidedBy],
      );
    await expect(decide(scope.userId)).rejects.toMatchObject({
      code: '23514',
      constraint: 'match_exceptions_approver_check',
    });
    await expect(decide(scope.otherUserId)).resolves.toBeTypeOf('string');
  });
});

describe('payment_request_lines', () => {
  it('refuses an amount of zero or less (23514) and an open item of another entity (23503)', async () => {
    const scope = await newScope();
    const other = await addEntity(scope);
    const vendorId = await insertVendor(scope, [scope.organizationId, other.organizationId]);
    const billId = await insertBill(scope, vendorId, { status: 'approved' });
    const openItem = (organizationId: string, sourceId: string) =>
      insertReturningId(
        organizationId,
        `INSERT INTO app.open_items
           (tenant_id, organization_id, side, direction, vendor_party_id, source_type, source_id, currency, amount,
            amount_npr, fx_rate, document_date)
         VALUES ($1, $2, 'payable', 'credit', $3, 'vendor_bill', $4, 'NPR', 565.00, 565.00, 1, '2026-11-06')
         RETURNING id`,
        [scope.tenantId, organizationId, vendorId, sourceId],
      );
    const itemId = await openItem(scope.organizationId, billId);
    const foreignItem = await openItem(other.organizationId, randomUUID());
    const evidence = await insertDocument(scope);
    const bankId = await insertReturningId(
      scope.organizationId,
      `INSERT INTO app.vendor_bank_accounts
         (tenant_id, vendor_id, bank_name, account_name, account_number_enc, account_fingerprint, last4, status,
          proposed_by, proposed_via, verified_by, callback_evidence_document_id)
       VALUES ($1, $2, 'Nabil Bank', 'Himal Supplies', '\\x00', 'fp', '4321', 'active', $3, 'staff', $4, $5)
       RETURNING id`,
      [scope.tenantId, vendorId, scope.userId, scope.otherUserId, evidence],
    );
    const seq = nextSeq();
    const requestId = await insertReturningId(
      scope.organizationId,
      `INSERT INTO app.payment_requests
         (tenant_id, organization_id, number, number_seq, fiscal_year, vendor_id, payment_type, currency,
          total_amount, from_bank_account_id, vendor_bank_account_id, bank_last4, requested_by)
       VALUES ($1, $2, $3, $4, '2083/84', $5, 'settlement', 'NPR', 565.00, $6, $7, '4321', $8) RETURNING id`,
      [
        scope.tenantId,
        scope.organizationId,
        `PAY-${seq}`,
        seq,
        vendorId,
        randomUUID(),
        bankId,
        scope.userId,
      ],
    );
    const line = (openItemId: string, amount: string, lineNo = 1) =>
      insertReturningId(
        scope.organizationId,
        `INSERT INTO app.payment_request_lines
           (tenant_id, organization_id, payment_request_id, line_no, open_item_id, amount)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [scope.tenantId, scope.organizationId, requestId, lineNo, openItemId, amount],
      );
    for (const amount of ['0.00', '-1.00']) {
      await expect(line(itemId, amount)).rejects.toMatchObject({
        code: '23514',
        constraint: 'payment_request_lines_amount_check',
      });
    }
    await expect(line(foreignItem, '100.00')).rejects.toMatchObject({
      code: '23503',
      constraint: 'payment_request_lines_open_item_fk',
    });
    await expect(line(itemId, '565.00')).resolves.toBeTypeOf('string');
  });
});

describe('v_po_line_progress', () => {
  it('gives ordered, cancelled, net confirmed receipts and live billed quantity per PO line', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const { poId, poLineId } = await orderOf(scope, vendorId, scope, '10', '1');
    const r1 = await receive(scope, poId, poLineId, '3');
    await receive(scope, poId, poLineId, '2');
    await receive(scope, poId, poLineId, '4', 'draft'); // not counted: still a draft
    const live = await insertBill(scope, vendorId, { poId, status: 'pending_approval' });
    await insertBillLine(scope, live, { poId, poLineId, receiptLineId: r1, quantity: '3' });
    const second = await insertBill(scope, vendorId, { poId });
    await insertBillLine(scope, second, { poId, poLineId, quantity: '1' });
    const rejected = await insertBill(scope, vendorId, { poId, status: 'rejected' });
    await insertBillLine(scope, rejected, { poId, poLineId, quantity: '2' }); // not counted: rejected
    const { rows } = await owner.query(
      `SELECT tenant_id, organization_id, purchase_order_id,
              ordered_quantity::text, cancelled_quantity::text, received_quantity::text, billed_quantity::text
         FROM app.v_po_line_progress WHERE po_line_id = $1`,
      [poLineId],
    );
    expect(rows).toEqual([
      {
        tenant_id: scope.tenantId,
        organization_id: scope.organizationId,
        purchase_order_id: poId,
        ordered_quantity: '10.0000',
        cancelled_quantity: '1.0000',
        received_quantity: '5.0000',
        billed_quantity: '4.0000',
      },
    ]);
  });

  it('nets a reversed receipt against its reversal', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const { poId, poLineId } = await orderOf(scope, vendorId, scope);
    await receive(scope, poId, poLineId, '3');
    const originalLine = await receive(scope, poId, poLineId, '2');
    const { rows: found } = await owner.query<{ receipt_id: string }>(
      `SELECT receipt_id FROM app.receipt_lines WHERE id = $1`,
      [originalLine],
    );
    const originalReceipt = found[0]?.receipt_id ?? '';
    await run(
      scope.organizationId,
      `UPDATE app.receipts SET status = 'reversed' WHERE tenant_id = $1 AND id = $2`,
      [scope.tenantId, originalReceipt],
    );
    const seq = nextSeq();
    const reversal = await insertReturningId(
      scope.organizationId,
      `INSERT INTO app.receipts
         (tenant_id, organization_id, number, number_seq, fiscal_year, purchase_order_id, kind, received_at,
          status, created_by, confirmed_by, confirmed_at, reverses_receipt_id, reversal_reason)
       VALUES ($1, $2, $3, $4, '2083/84', $5, 'goods', '2026-11-06', 'confirmed', $6, $6, now(), $7,
               'Wrong delivery note') RETURNING id`,
      [
        scope.tenantId,
        scope.organizationId,
        `GRN-${seq}`,
        seq,
        poId,
        scope.userId,
        originalReceipt,
      ],
    );
    await run(
      scope.organizationId,
      `INSERT INTO app.receipt_lines
         (tenant_id, organization_id, receipt_id, purchase_order_id, po_line_id, line_no, quantity,
          reverses_receipt_line_id)
       VALUES ($1, $2, $3, $4, $5, 1, -2, $6)`,
      [scope.tenantId, scope.organizationId, reversal, poId, poLineId, originalLine],
    );
    const { rows } = await owner.query(
      `SELECT received_quantity::text FROM app.v_po_line_progress WHERE po_line_id = $1`,
      [poLineId],
    );
    expect(rows).toEqual([{ received_quantity: '3.0000' }]);
  });

  it('shows zero received and billed for a line with neither', async () => {
    const scope = await newScope();
    const vendorId = await insertVendor(scope, [scope.organizationId]);
    const { poLineId } = await orderOf(scope, vendorId, scope);
    const { rows } = await owner.query(
      `SELECT received_quantity::text, billed_quantity::text FROM app.v_po_line_progress WHERE po_line_id = $1`,
      [poLineId],
    );
    expect(rows).toEqual([{ received_quantity: '0.0000', billed_quantity: '0.0000' }]);
  });
});
