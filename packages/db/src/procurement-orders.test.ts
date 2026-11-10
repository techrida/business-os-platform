// Integration tests for 0034_procurement_orders (P4 unit S-PR2) on a real, empty postgres:16-alpine started by
// Testcontainers (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/procurement-orders.test.ts
//
// What 0034 must hold:
//   * the migrations apply on a fresh database, and the six order and receipt tables exist;
//   * checkTenancy() with its strict defaults and checkAudit() find nothing;
//   * a PO is raised in one entity for a vendor that has an account there, from its own request, RFQ and quotation;
//   * a PO line belongs to its own PO and entity (23503); a receipt line receives only against a line of its own PO;
//   * receipts cannot exceed what was ordered less what was cancelled, unless an exception id is on the line (AD16
//     keeps stock and GRNI out; this is only the quantity guard);
//   * a negative quantity exists only on a reversal line that names the line it reverses, in full, in the
//     reversal receipt of that receipt;
//   * purchase_order_versions are immutable (the trigger, and the missing privilege for bos_app);
//   * a serial number is recorded once per receipt line.
//
// Setup mirrors procurement.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app inside a transaction that names the acting entity (like withTx).
import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import { runMigrations } from './migrate.js';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
} from './testing/fixtures.js';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

const ORDER_TABLES = [
  'purchase_orders',
  'purchase_order_versions',
  'purchase_order_lines',
  'receipts',
  'receipt_lines',
  'receipt_serials',
] as const;

let container: StartedPostgreSqlContainer;
let owner: Pool;
let app: Pool;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

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

/** A running number for the PO, GRN and (fiscal year, sequence) keys. */
let counter = 0;
const nextSeq = () => ++counter;

interface Chain {
  prId: string;
  prLineId: string;
  rfqId: string;
  vendorId: string;
  quotationId: string;
}

/** The sourcing chain a PO is raised from: request, line, RFQ, invited vendor with an account, quotation. */
async function sourcingChain(scope: Scope): Promise<Chain> {
  const prId = await insertPr(scope);
  const prLineId = await insertPrLine(scope, prId, 1);
  const rfqId = await insertRfq(scope, prId);
  const vendorId = await insertVendor(scope);
  await insertVendorAccount(scope, vendorId, scope.organizationId);
  await inviteVendor(scope, rfqId, vendorId);
  const quotationId = await insertQuotation(scope, rfqId, prId, vendorId);
  return { prId, prLineId, rfqId, vendorId, quotationId };
}

interface PoOptions {
  vendorId?: string;
  rfqId?: string | null;
  quotationId?: string | null;
  prId?: string;
  band?: string;
  total?: string;
  totalNpr?: string;
}

/** A draft PO of 3391.13 (NPR) raised from the chain. */
function insertPo(scope: Scope, chain: Chain, options: PoOptions = {}): Promise<string> {
  const seq = nextSeq();
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.purchase_orders
       (tenant_id, organization_id, number, number_seq, fiscal_year, purchase_request_id, rfq_id,
        vendor_quotation_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
        approved_total_npr, approved_band, created_by)
     VALUES ($1, $2, $3, $4, '2083/84', $5, $6, $7, $8, 'NPR', 30, $9, 1, $10, $11, $12)
     RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      `PO-${seq}`,
      seq,
      options.prId ?? chain.prId,
      options.rfqId === undefined ? chain.rfqId : options.rfqId,
      options.quotationId === undefined ? chain.quotationId : options.quotationId,
      options.vendorId ?? chain.vendorId,
      options.total ?? '3391.13',
      options.totalNpr ?? '3391.13',
      options.band ?? 'base',
      scope.userId,
    ],
  );
}

interface PoLineOptions {
  quantity?: string;
  cancelled?: string;
  kind?: string;
  requiresSerials?: boolean;
  lineNo?: number;
  organizationId?: string;
  prLineId?: string | null;
}

/** A PO line at 100.00 a unit with 13% tax. Defaults to 5 units, goods. */
function insertPoLine(
  scope: Scope,
  poId: string,
  chain: Chain,
  options: PoLineOptions = {},
): Promise<string> {
  const quantity = options.quantity ?? '5';
  const gross = (Number(quantity) * 100).toFixed(2);
  const tax = (Number(quantity) * 13).toFixed(2);
  const total = (Number(quantity) * 113).toFixed(2);
  const organizationId = options.organizationId ?? scope.organizationId;
  return insertReturningId(
    organizationId,
    `INSERT INTO app.purchase_order_lines
       (tenant_id, organization_id, purchase_order_id, purchase_request_id, line_no, pr_line_id, kind,
        description, uom, ordered_quantity, cancelled_quantity, unit_price, tax_code_id, gross, tax_amount,
        line_total, requires_serials)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '24-port switch', 'pcs', $8, $9, 100.00, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      scope.tenantId,
      organizationId,
      poId,
      chain.prId,
      options.lineNo ?? 1,
      options.prLineId ?? null,
      options.kind ?? 'goods',
      quantity,
      options.cancelled ?? '0',
      scope.taxCodeId,
      gross,
      tax,
      total,
      options.requiresSerials ?? false,
    ],
  );
}

interface ReceiptOptions {
  reverses?: string | null;
  status?: string;
}

/** A goods receipt of a PO. Confirmed by default; a reversal receipt names the receipt it reverses. */
function insertReceipt(scope: Scope, poId: string, options: ReceiptOptions = {}): Promise<string> {
  const seq = nextSeq();
  const status = options.status ?? 'confirmed';
  const reverses = options.reverses ?? null;
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.receipts
       (tenant_id, organization_id, number, number_seq, fiscal_year, purchase_order_id, kind, received_at,
        status, created_by, confirmed_by, confirmed_at, reverses_receipt_id, reversal_reason)
     VALUES ($1, $2, $3, $4, '2083/84', $5, 'goods', '2026-11-05', $6, $7, $8, $9, $10, $11)
     RETURNING id`,
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
      reverses,
      reverses === null ? null : 'Wrong delivery note',
    ],
  );
}

interface ReceiptLineOptions {
  exceptionId?: string | null;
  reverses?: string | null;
  lineNo?: number;
}

/** One line of a receipt: `quantity` of a PO line (negative only on a reversal line). */
function insertReceiptLine(
  scope: Scope,
  receiptId: string,
  poId: string,
  poLineId: string,
  quantity: string,
  options: ReceiptLineOptions = {},
): Promise<string> {
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.receipt_lines
       (tenant_id, organization_id, receipt_id, purchase_order_id, po_line_id, line_no, quantity,
        reverses_receipt_line_id, over_receipt_exception_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      receiptId,
      poId,
      poLineId,
      options.lineNo ?? 1,
      quantity,
      options.reverses ?? null,
      options.exceptionId ?? null,
    ],
  );
}

/** A PO with one 5-unit line, ready to receive against. */
async function orderOfFive(scope: Scope, options: PoLineOptions = {}) {
  const chain = await sourcingChain(scope);
  const poId = await insertPo(scope, chain);
  const poLineId = await insertPoLine(scope, poId, chain, options);
  return { chain, poId, poLineId };
}

/** The net quantity received on a PO line: every receipt line, whatever the receipt status. */
async function netReceived(poLineId: string): Promise<string> {
  const { rows } = await owner.query<{ net: string }>(
    `SELECT coalesce(sum(quantity), 0)::text AS net FROM app.receipt_lines WHERE po_line_id = $1`,
    [poLineId],
  );
  return rows[0]?.net ?? 'none';
}

function insertVersion(
  scope: Scope,
  poId: string,
  version: number,
  reason: string | null,
): Promise<string> {
  return insertReturningId(
    scope.organizationId,
    `INSERT INTO app.purchase_order_versions
       (tenant_id, organization_id, purchase_order_id, version, reason, total, total_npr, band, snapshot,
        created_by)
     VALUES ($1, $2, $3, $4, $5, 3391.13, 3391.13, 'base', '{"lines": []}', $6) RETURNING id`,
    [scope.tenantId, scope.organizationId, poId, version, reason, scope.userId],
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();

  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:procurement-orders-test'],
    ['bos.correlation_id', 'procurement-orders-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE bos SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  owner = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  app = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 2 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await container?.stop();
});

describe('0034_procurement_orders on a fresh database', () => {
  it('applies, and creates the six order and receipt tables', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...ORDER_TABLES]],
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

  it('records a purchase order write in the audit trail under its entity', async () => {
    const scope = await newScope();
    const { poId } = await orderOfFive(scope);
    const { rows } = await owner.query<{ organization_id: string }>(
      `SELECT organization_id FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'purchase_orders' AND entity_id = $2`,
      [scope.tenantId, poId],
    );
    expect(rows).toEqual([{ organization_id: scope.organizationId }]);
  });
});

describe('a purchase order is raised from its own sourcing chain, in one entity', () => {
  it('refuses a vendor with no account in the PO entity (23503)', async () => {
    const scope = await newScope();
    const chain = await sourcingChain(scope);
    const other = await addEntity(scope);
    const outsider = await insertVendor(scope);
    await insertVendorAccount(scope, outsider, other.organizationId);
    await expect(
      insertPo(scope, chain, { vendorId: outsider, quotationId: null, rfqId: null }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'purchase_orders_vendor_account_fk' });
  });

  it('refuses a quotation of another vendor, an RFQ of another request, and a half-sourced PO', async () => {
    const scope = await newScope();
    const chain = await sourcingChain(scope);
    const rival = await insertVendor(scope);
    await insertVendorAccount(scope, rival, scope.organizationId);
    await expect(insertPo(scope, chain, { vendorId: rival })).rejects.toMatchObject({
      code: '23503',
      constraint: 'purchase_orders_quotation_vendor_fk',
    });
    const otherPr = await insertPr(scope);
    await expect(insertPo(scope, chain, { prId: otherPr })).rejects.toMatchObject({
      code: '23503',
      constraint: 'purchase_orders_rfq_fk',
    });
    await expect(insertPo(scope, chain, { quotationId: null })).rejects.toMatchObject({
      code: '23514',
      constraint: 'purchase_orders_source_check',
    });
  });

  it('allows one live PO per quotation, and a new one once the first is cancelled', async () => {
    const scope = await newScope();
    const chain = await sourcingChain(scope);
    const first = await insertPo(scope, chain);
    await expect(insertPo(scope, chain)).rejects.toMatchObject({
      code: '23505',
      constraint: 'purchase_orders_tenant_quotation_live_unique',
    });
    await run(
      scope.organizationId,
      `UPDATE app.purchase_orders
          SET status = 'cancelled', issued_at = now(), issued_by = $3, current_version = 1,
              closed_reason = 'Vendor withdrew'
        WHERE tenant_id = $1 AND id = $2`,
      [scope.tenantId, first, scope.userId],
    );
    await expect(insertPo(scope, chain)).resolves.toEqual(expect.any(String));
  });

  it('holds the band, the NPR snapshot and the issue columns honest (23514)', async () => {
    const scope = await newScope();
    const chain = await sourcingChain(scope);
    // 'none' is not a band: the contract's lowest band is 'base' (PO_APPROVED_BANDS).
    await expect(insertPo(scope, chain, { band: 'none' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'purchase_orders_approved_band_check',
    });
    await expect(insertPo(scope, chain, { totalNpr: '3000.00' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'purchase_orders_npr_snapshot_check',
    });
    const poId = await insertPo(scope, chain);
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.purchase_orders SET status = 'issued' WHERE tenant_id = $1 AND id = $2`,
        [scope.tenantId, poId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'purchase_orders_issued_check' });
  });
});

describe('purchase order lines', () => {
  it('refuses a line whose PO is in another entity (23503)', async () => {
    const scope = await newScope();
    const { chain, poId } = await orderOfFive(scope);
    const other = await addEntity(scope);
    await expect(
      insertPoLine(scope, poId, chain, { organizationId: other.organizationId, lineNo: 2 }),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'purchase_order_lines_purchase_order_fk',
    });
  });

  it('prices a line of the PO own request only, and holds its amounts (23503 / 23514)', async () => {
    const scope = await newScope();
    const { chain, poId } = await orderOfFive(scope);
    const foreignPr = await insertPr(scope);
    const foreignPrLine = await insertPrLine(scope, foreignPr, 1);
    await expect(
      insertPoLine(scope, poId, chain, { lineNo: 2, prLineId: foreignPrLine }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'purchase_order_lines_pr_line_fk' });
    await expect(
      insertPoLine(scope, poId, chain, { lineNo: 3, prLineId: chain.prLineId }),
    ).resolves.toEqual(expect.any(String));
    await expect(
      insertPoLine(scope, poId, chain, { lineNo: 4, quantity: '5', cancelled: '6' }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'purchase_order_lines_cancelled_check' });
    await expect(
      insertPoLine(scope, poId, chain, { lineNo: 5, kind: 'service', requiresSerials: true }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'purchase_order_lines_serials_check' });
  });

  it('refuses to shrink the open quantity below what was received, but not to cancel the rest', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, poId);
    await insertReceiptLine(scope, receiptId, poId, poLineId, '4');
    const cancel = (quantity: number) =>
      run(
        scope.organizationId,
        `UPDATE app.purchase_order_lines SET cancelled_quantity = $3 WHERE tenant_id = $1 AND id = $2`,
        [scope.tenantId, poLineId, quantity],
      );
    await expect(cancel(2)).rejects.toMatchObject({
      code: '23514',
      constraint: 'purchase_order_lines_open_quantity_check',
    });
    await cancel(1);
  });
});

describe('over-receipt', () => {
  it('refuses receiving 6 against 5 without an exception (23514)', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, poId);
    await expect(insertReceiptLine(scope, receiptId, poId, poLineId, '6')).rejects.toMatchObject({
      code: '23514',
      constraint: 'receipt_lines_over_receipt_check',
    });
    expect(await netReceived(poLineId)).toBe('0');
  });

  it('allows receiving 6 against 5 when the line carries an over-receipt exception id', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, poId);
    await insertReceiptLine(scope, receiptId, poId, poLineId, '6', { exceptionId: randomUUID() });
    expect(await netReceived(poLineId)).toBe('6.0000');
  });

  it('counts every receipt of the line, and lets the exact total through', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const first = await insertReceipt(scope, poId);
    await insertReceiptLine(scope, first, poId, poLineId, '3');
    const second = await insertReceipt(scope, poId);
    await expect(insertReceiptLine(scope, second, poId, poLineId, '3')).rejects.toMatchObject({
      code: '23514',
      constraint: 'receipt_lines_over_receipt_check',
    });
    await insertReceiptLine(scope, second, poId, poLineId, '2');
    expect(await netReceived(poLineId)).toBe('5.0000');
  });

  it('counts a draft receipt, so two drafts cannot both claim the same units', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const draft = await insertReceipt(scope, poId, { status: 'draft' });
    await insertReceiptLine(scope, draft, poId, poLineId, '4');
    const second = await insertReceipt(scope, poId, { status: 'draft' });
    await expect(insertReceiptLine(scope, second, poId, poLineId, '4')).rejects.toMatchObject({
      constraint: 'receipt_lines_over_receipt_check',
    });
  });

  it('measures against ordered minus cancelled', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope, { cancelled: '2' });
    const receiptId = await insertReceipt(scope, poId);
    await expect(insertReceiptLine(scope, receiptId, poId, poLineId, '4')).rejects.toMatchObject({
      constraint: 'receipt_lines_over_receipt_check',
    });
    await insertReceiptLine(scope, receiptId, poId, poLineId, '3');
  });

  it('refuses a line of another PO (23503) even in the same entity', async () => {
    const scope = await newScope();
    const mine = await orderOfFive(scope);
    const theirs = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, mine.poId);
    await expect(
      insertReceiptLine(scope, receiptId, mine.poId, theirs.poLineId, '1'),
    ).rejects.toMatchObject({ code: '23503', constraint: 'receipt_lines_po_line_fk' });
  });
});

describe('a reversal is a negative line that names the line it reverses', () => {
  it('refuses a negative quantity with no reference, and a reference on a positive one (23514)', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, poId);
    const original = await insertReceiptLine(scope, receiptId, poId, poLineId, '5');
    const second = await insertReceipt(scope, poId);
    await expect(insertReceiptLine(scope, second, poId, poLineId, '-5')).rejects.toMatchObject({
      code: '23514',
      constraint: 'receipt_lines_reversal_check',
    });
    // The guard trigger fires before the CHECK, so a positive line that names a line is refused by the trigger.
    await expect(
      insertReceiptLine(scope, second, poId, poLineId, '1', { reverses: original }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(insertReceiptLine(scope, second, poId, poLineId, '0')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('takes a full reversal in the reversal receipt, and frees the quantity again', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, poId);
    const original = await insertReceiptLine(scope, receiptId, poId, poLineId, '5');
    const reversal = await insertReceipt(scope, poId, { reverses: receiptId });
    await insertReceiptLine(scope, reversal, poId, poLineId, '-5', { reverses: original });
    expect(await netReceived(poLineId)).toBe('0.0000');
    await run(
      scope.organizationId,
      `UPDATE app.receipts SET status = 'reversed' WHERE tenant_id = $1 AND id = $2`,
      [scope.tenantId, receiptId],
    );
    // The reversed units can be received again, and no more than that.
    const again = await insertReceipt(scope, poId);
    await expect(insertReceiptLine(scope, again, poId, poLineId, '6')).rejects.toMatchObject({
      constraint: 'receipt_lines_over_receipt_check',
    });
    await insertReceiptLine(scope, again, poId, poLineId, '5');
    expect(await netReceived(poLineId)).toBe('5.0000');
  });

  it('refuses a partial reversal, a reversal outside the reversal receipt, and a plain line in one', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, poId);
    const original = await insertReceiptLine(scope, receiptId, poId, poLineId, '5');
    const reversal = await insertReceipt(scope, poId, { reverses: receiptId });
    const mismatch = { code: '23514', constraint: 'receipt_lines_reversal_match_check' };
    await expect(
      insertReceiptLine(scope, reversal, poId, poLineId, '-3', { reverses: original }),
    ).rejects.toMatchObject(mismatch);
    const plain = await insertReceipt(scope, poId);
    await expect(
      insertReceiptLine(scope, plain, poId, poLineId, '-5', { reverses: original }),
    ).rejects.toMatchObject(mismatch);
    await expect(insertReceiptLine(scope, reversal, poId, poLineId, '1')).rejects.toMatchObject(
      mismatch,
    );
  });

  it('refuses a second reversal of a receipt or a line (23505), and a self-reversal (23514)', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, poId);
    const original = await insertReceiptLine(scope, receiptId, poId, poLineId, '5');
    const reversal = await insertReceipt(scope, poId, { reverses: receiptId });
    await insertReceiptLine(scope, reversal, poId, poLineId, '-5', { reverses: original });
    await expect(insertReceipt(scope, poId, { reverses: receiptId })).rejects.toMatchObject({
      code: '23505',
      constraint: 'receipts_tenant_org_reverses_unique',
    });
    await expect(
      run(
        scope.organizationId,
        `UPDATE app.receipts SET reverses_receipt_id = id, reversal_reason = 'x' WHERE tenant_id = $1 AND id = $2`,
        [scope.tenantId, receiptId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'receipts_reversal_check' });
  });

  it('refuses to delete a reversal line, which would reopen the reversed quantity (23514)', async () => {
    const scope = await newScope();
    const { poId, poLineId } = await orderOfFive(scope);
    const receiptId = await insertReceipt(scope, poId);
    const original = await insertReceiptLine(scope, receiptId, poId, poLineId, '5');
    const reversal = await insertReceipt(scope, poId, { reverses: receiptId });
    const reversalLine = await insertReceiptLine(scope, reversal, poId, poLineId, '-5', {
      reverses: original,
    });
    const again = await insertReceipt(scope, poId);
    await insertReceiptLine(scope, again, poId, poLineId, '5');
    await expect(
      run(scope.organizationId, `DELETE FROM app.receipt_lines WHERE tenant_id = $1 AND id = $2`, [
        scope.tenantId,
        reversalLine,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'receipt_lines_reversal_delete_check' });
    expect(await netReceived(poLineId)).toBe('5.0000');
  });

  it('refuses a reversal of a line of another PO line or another PO (23503)', async () => {
    const scope = await newScope();
    const { chain, poId, poLineId } = await orderOfFive(scope);
    const secondLine = await insertPoLine(scope, poId, chain, { lineNo: 2 });
    const receiptId = await insertReceipt(scope, poId);
    const original = await insertReceiptLine(scope, receiptId, poId, poLineId, '5');
    const reversal = await insertReceipt(scope, poId, { reverses: receiptId });
    await expect(
      insertReceiptLine(scope, reversal, poId, secondLine, '-5', { reverses: original }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'receipt_lines_reverses_fk' });
    // A receipt of this PO that nobody reversed yet, named by a reversal receipt of a different PO.
    const unreversed = await insertReceipt(scope, poId);
    const other = await orderOfFive(scope);
    await expect(insertReceipt(scope, other.poId, { reverses: unreversed })).rejects.toMatchObject({
      code: '23503',
      constraint: 'receipts_reverses_fk',
    });
  });
});

describe('purchase order versions are immutable', () => {
  it('refuses UPDATE and DELETE to bos_app by privilege (42501) and to the owner by trigger (23514)', async () => {
    const scope = await newScope();
    const { poId } = await orderOfFive(scope);
    const versionId = await insertVersion(scope, poId, 1, null);
    for (const sql of [
      `UPDATE app.purchase_order_versions SET total = 1 WHERE id = $1`,
      `DELETE FROM app.purchase_order_versions WHERE id = $1`,
    ]) {
      await expect(run(scope.organizationId, sql, [versionId]), sql).rejects.toMatchObject({
        code: '42501',
      });
    }
    const trigger = { code: '23514', constraint: 'purchase_order_versions_immutable' };
    await expect(
      owner.query(`UPDATE app.purchase_order_versions SET total = 1 WHERE id = $1`, [versionId]),
    ).rejects.toMatchObject(trigger);
    await expect(
      owner.query(`DELETE FROM app.purchase_order_versions WHERE id = $1`, [versionId]),
    ).rejects.toMatchObject(trigger);
    const { rows } = await owner.query<{ total: string }>(
      `SELECT total::text FROM app.purchase_order_versions WHERE id = $1`,
      [versionId],
    );
    expect(rows).toEqual([{ total: '3391.13' }]);
  });

  it('numbers versions per PO, and an amendment (version 2 on) gives its reason', async () => {
    const scope = await newScope();
    const { poId } = await orderOfFive(scope);
    await insertVersion(scope, poId, 1, null);
    await expect(insertVersion(scope, poId, 1, null)).rejects.toMatchObject({
      code: '23505',
      constraint: 'purchase_order_versions_tenant_org_po_version_unique',
    });
    await expect(insertVersion(scope, poId, 2, null)).rejects.toMatchObject({
      code: '23514',
      constraint: 'purchase_order_versions_reason_check',
    });
    await insertVersion(scope, poId, 2, 'Quantity raised from 5 to 8');
  });
});

describe('receipt serials', () => {
  it('records a serial once per receipt line (23505), and the same serial on another line', async () => {
    const scope = await newScope();
    const { chain, poId, poLineId } = await orderOfFive(scope, { requiresSerials: true });
    const secondPoLine = await insertPoLine(scope, poId, chain, {
      lineNo: 2,
      requiresSerials: true,
    });
    const receiptId = await insertReceipt(scope, poId);
    const lineOne = await insertReceiptLine(scope, receiptId, poId, poLineId, '2');
    const lineTwo = await insertReceiptLine(scope, receiptId, poId, secondPoLine, '1', {
      lineNo: 2,
    });
    const serial = (lineId: string, serialNo: string) =>
      run(
        scope.organizationId,
        `INSERT INTO app.receipt_serials (tenant_id, organization_id, receipt_line_id, serial_no)
         VALUES ($1, $2, $3, $4)`,
        [scope.tenantId, scope.organizationId, lineId, serialNo],
      );
    await serial(lineOne, 'SN-0001');
    await serial(lineOne, 'SN-0002');
    await expect(serial(lineOne, 'SN-0001')).rejects.toMatchObject({
      code: '23505',
      constraint: 'receipt_serials_tenant_line_serial_unique',
    });
    await serial(lineTwo, 'SN-0001');
    await expect(serial(lineOne, '  ')).rejects.toMatchObject({
      code: '23514',
      constraint: 'receipt_serials_serial_no_check',
    });
  });
});
