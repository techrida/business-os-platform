// Integration tests for 0023_invoice_credit_release (P3 unit U12 part A) on a real, empty postgres:16-alpine started
// by Testcontainers (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/invoice-credit-release.test.ts
//
// What 0023 must hold, written as bos_app (the API's role) unless a case says otherwise:
//   * invoices.credited_in_full_at exists (timestamptz, NULL); checkTenancy() (strict) and checkAudit() find nothing;
//   * the marker can be set once on an issued invoice with every other column unchanged (version and updated_at may
//     move, as for any issued invoice); a later change of it is refused, so is any other change made together with
//     it, and so is a marker on an invoice that is not issued;
//   * G4 still holds (a second live tax invoice on a schedule line is refused) until the first invoice carries the
//     marker, which frees the line for a new tax invoice.
//
// Setup mirrors invoicing.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app, with the acting entity set per transaction like withTx.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import { createParty, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

/** A small SO (NPR 113,000.00 including 13% VAT) with a single 100% billing line. */
const ORDER = {
  subtotal: '100000.00',
  discount: '0.00',
  taxable: '100000.00',
  tax: '13000.00',
  total: '113000.00',
};

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

/** One statement in `scope`'s entity; returns the first row's id when the statement has RETURNING id. */
async function exec(scope: Scope, sql: string, params: unknown[] = []): Promise<string> {
  return inTx(scope.organizationId, async (c) => {
    const { rows } = await c.query<{ id?: string }>(sql, params);
    return rows[0]?.id ?? '';
  });
}

async function newScope(): Promise<Scope> {
  const { tenantId, organizationId } = await createTenantWithEntity(app);
  return { tenantId, organizationId };
}

/** A customer party and its customer row (tenant-level). */
async function insertCustomer(scope: Scope): Promise<string> {
  const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'customer' });
  await exec(
    scope,
    `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address_line, address_city)
     VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', 'Durbar Marg 1', 'Kathmandu')`,
    [partyId, scope.tenantId, `CUS-${partyId.slice(0, 8)}`],
  );
  return partyId;
}

/** A sales order of `scope`'s entity with one billing line for the whole total; returns customer, order and line. */
async function orderWithOneLine(scope: Scope) {
  const customerPartyId = await insertCustomer(scope);
  const opportunityId = await exec(
    scope,
    `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id)
     VALUES ($1, $2, $3, 'Acme website', $4) RETURNING id`,
    [scope.tenantId, scope.organizationId, `DEAL-${randomUUID().slice(0, 8)}`, customerPartyId],
  );
  const quotationId = await exec(
    scope,
    `INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      `QT-${randomUUID().slice(0, 8)}`,
      customerPartyId,
      opportunityId,
    ],
  );
  const versionId = await exec(
    scope,
    `INSERT INTO app.quotation_versions
       (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
     VALUES ($1, $2, $3, 1, 'NPR', '2026-11-09', '2026-12-09') RETURNING id`,
    [scope.tenantId, scope.organizationId, quotationId],
  );
  const salesOrderId = await exec(
    scope,
    `INSERT INTO app.sales_orders
       (tenant_id, organization_id, customer_party_id, quotation_id, quotation_version_id, currency,
        subtotal, discount_amount, taxable_amount, tax_amount, total, fx_rate, amount_npr, credit_days)
     VALUES ($1, $2, $3, $4, $5, 'NPR', $6, $7, $8, $9, $10, 1, $10, 30) RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      customerPartyId,
      quotationId,
      versionId,
      ORDER.subtotal,
      ORDER.discount,
      ORDER.taxable,
      ORDER.tax,
      ORDER.total,
    ],
  );
  const lineId = await exec(
    scope,
    `INSERT INTO app.billing_schedule_lines
       (tenant_id, organization_id, sales_order_id, seq, label, "trigger", percent, amount, amount_npr, status)
     VALUES ($1, $2, $3, 1, 'Full payment', 'advance', 100, $4, $4, 'planned') RETURNING id`,
    [scope.tenantId, scope.organizationId, salesOrderId, ORDER.total],
  );
  return { customerPartyId, salesOrderId, lineId };
}

/** A draft tax invoice for the whole order on the order's billing line (or a manual one without them). */
function insertInvoice(
  scope: Scope,
  customerPartyId: string,
  link?: { salesOrderId: string; lineId: string },
): Promise<string> {
  return exec(
    scope,
    `INSERT INTO app.invoices
       (tenant_id, organization_id, kind, customer_party_id, sales_order_id, schedule_line_id, manual_reason,
        currency, subtotal, discount_amount, taxable_vat_amount, tax_amount, total)
     VALUES ($1, $2, 'tax_invoice', $3, $4, $5, $6, 'NPR', $7, $8, $9, $10, $11) RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      customerPartyId,
      link?.salesOrderId ?? null,
      link?.lineId ?? null,
      link ? null : 'One-off hardware sale',
      ORDER.subtotal,
      ORDER.discount,
      ORDER.taxable,
      ORDER.tax,
      ORDER.total,
    ],
  );
}

let nextSeq = 1;

/** Issues a draft as the issue command would: number, BS date, NPR snapshot, snapshots and hash in one UPDATE. */
async function issue(scope: Scope, invoiceId: string): Promise<void> {
  const seq = nextSeq++;
  await exec(
    scope,
    `UPDATE app.invoices
        SET status = 'issued', number = $2, seq = $3, fiscal_year = '2083/84', issue_date = '2026-11-09',
            issue_date_bs = '2083-07-23', due_date = '2026-12-09', fx_rate = 1, amount_npr = total,
            seller_snapshot = '{"name": "Techrida Pvt. Ltd.", "pan": "600000001"}',
            buyer_snapshot = '{"name": "Acme Pvt. Ltd."}', content_hash = decode(repeat('ab', 32), 'hex'),
            issued_at = now()
      WHERE id = $1`,
    [invoiceId, `INV-2083/84-${String(seq).padStart(5, '0')}`, seq],
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
    ['bos.actor_id', 'system:credit-release-test'],
    ['bos.correlation_id', 'credit-release-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

const IMMUTABLE = { code: '23514', constraint: 'invoices_issued_immutable_check' };
const MARKER = { code: '23514', constraint: 'invoices_credit_marker_check' };
const SET_MARKER = `UPDATE app.invoices SET credited_in_full_at = $2 WHERE id = $1`;

async function markerOf(invoiceId: string): Promise<string | null> {
  const { rows } = await app.query<{ at: string | null }>(
    `SELECT to_char(credited_in_full_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS at
       FROM app.invoices WHERE id = $1`,
    [invoiceId],
  );
  return rows[0]?.at ?? null;
}

describe('0023_invoice_credit_release on a fresh database', () => {
  it('adds a nullable timestamptz credited_in_full_at to invoices', async () => {
    const { rows } = await owner.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'invoices' AND column_name = 'credited_in_full_at'`,
    );
    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
  });

  it('passes checkTenancy() with the strict defaults', async () => {
    const violations = await checkTenancy(owner);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('passes checkAudit(): invoices stays audited', async () => {
    await expect(checkAudit(owner)).resolves.toEqual([]);
  });
});

describe('the credit-release marker on an issued invoice', () => {
  it('can be set once, with version and updated_at moving, and every other column unchanged', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    const invoice = await insertInvoice(scope, customer);
    await issue(scope, invoice);
    const before = await app.query(
      `SELECT to_jsonb(i) - 'credited_in_full_at' - 'version' - 'updated_at' AS row FROM app.invoices i WHERE id = $1`,
      [invoice],
    );
    await expect(markerOf(invoice)).resolves.toBeNull();

    await exec(
      scope,
      `UPDATE app.invoices SET credited_in_full_at = '2026-11-10T08:00:00Z', version = version + 1, updated_at = now()
        WHERE id = $1`,
      [invoice],
    );

    await expect(markerOf(invoice)).resolves.toBe('2026-11-10T08:00:00');
    const after = await app.query(
      `SELECT to_jsonb(i) - 'credited_in_full_at' - 'version' - 'updated_at' AS row FROM app.invoices i WHERE id = $1`,
      [invoice],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('refuses a second change of the marker: to another value, back to NULL (23514)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    const invoice = await insertInvoice(scope, customer);
    await issue(scope, invoice);
    await exec(scope, SET_MARKER, [invoice, '2026-11-10T08:00:00Z']);

    await expect(exec(scope, SET_MARKER, [invoice, '2026-11-11T08:00:00Z'])).rejects.toMatchObject(
      IMMUTABLE,
    );
    await expect(exec(scope, SET_MARKER, [invoice, null])).rejects.toMatchObject(IMMUTABLE);
    await expect(markerOf(invoice)).resolves.toBe('2026-11-10T08:00:00');
    // Anything else on the marked invoice stays refused too.
    await expect(
      exec(scope, `UPDATE app.invoices SET due_date = '2027-01-31' WHERE id = $1`, [invoice]),
    ).rejects.toMatchObject(IMMUTABLE);
  });

  it('refuses any other column changed together with it (23514)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    const invoice = await insertInvoice(scope, customer);
    await issue(scope, invoice);
    const attempts = [
      `due_date = '2027-01-31'`,
      `buyer_snapshot = '{"name": "Someone else"}'`,
      `manual_reason = 'Edited later'`,
      `content_hash = decode(repeat('cd', 32), 'hex')`,
      `issued_at = now() + interval '1 day'`,
      `subtotal = 1, discount_amount = 0, taxable_vat_amount = 1, tax_amount = 0, total = 1, amount_npr = 1`,
      `status = 'draft', number = NULL, seq = NULL, fiscal_year = NULL, issue_date_bs = NULL`,
    ];
    for (const set of attempts) {
      await expect(
        exec(scope, `UPDATE app.invoices SET credited_in_full_at = now(), ${set} WHERE id = $1`, [
          invoice,
        ]),
        set,
      ).rejects.toMatchObject(IMMUTABLE);
    }
    await expect(markerOf(invoice)).resolves.toBeNull();
  });

  it('cannot be set on an invoice that is not issued, nor inserted set (23514)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    const draft = await insertInvoice(scope, customer);
    await expect(exec(scope, SET_MARKER, [draft, '2026-11-10T08:00:00Z'])).rejects.toMatchObject(
      MARKER,
    );
    // Issuing and marking in one statement is not a marker on an issued invoice either.
    await expect(
      exec(
        scope,
        `UPDATE app.invoices
            SET status = 'issued', number = 'INV-2083/84-90001', seq = 90001, fiscal_year = '2083/84',
                issue_date = '2026-11-09', issue_date_bs = '2083-07-23', fx_rate = 1, amount_npr = total,
                seller_snapshot = '{"name": "T"}', buyer_snapshot = '{"name": "A"}',
                content_hash = decode(repeat('ab', 32), 'hex'), issued_at = now(),
                credited_in_full_at = now()
          WHERE id = $1`,
        [draft],
      ),
    ).rejects.toMatchObject(MARKER);
    await expect(
      exec(
        scope,
        `INSERT INTO app.invoices
           (tenant_id, organization_id, kind, customer_party_id, manual_reason, currency, credited_in_full_at)
         VALUES ($1, $2, 'tax_invoice', $3, 'One-off', 'NPR', now())`,
        [scope.tenantId, scope.organizationId, customer],
      ),
    ).rejects.toMatchObject(MARKER);
    await expect(markerOf(draft)).resolves.toBeNull();
  });
});

describe('G4 with the marker: a credited-in-full invoice frees its schedule line', () => {
  it('refuses a second live tax invoice on the line until the first carries the marker (23505)', async () => {
    const scope = await newScope();
    const { customerPartyId, salesOrderId, lineId } = await orderWithOneLine(scope);
    const link = { salesOrderId, lineId };
    const first = await insertInvoice(scope, customerPartyId, link);
    await issue(scope, first);
    const duplicate = {
      code: '23505',
      constraint: 'invoices_one_live_tax_invoice_per_schedule_line',
    };

    await expect(insertInvoice(scope, customerPartyId, link)).rejects.toMatchObject(duplicate);

    await exec(scope, SET_MARKER, [first, '2026-11-10T08:00:00Z']);

    const second = await insertInvoice(scope, customerPartyId, link);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    // The new one is live again, so a third is refused; the marked first still counts for nothing.
    await expect(insertInvoice(scope, customerPartyId, link)).rejects.toMatchObject(duplicate);
    await expect(markerOf(first)).resolves.toBe('2026-11-10T08:00:00');
  });
});
