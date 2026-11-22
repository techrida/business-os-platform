// Integration tests for 0021_invoices (P3 unit U1) on a real, empty postgres:16-alpine started by Testcontainers
// (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/invoicing.test.ts
//
// What 0021 must hold, written as bos_app (the API's role) unless a case says otherwise:
//   * the migrations apply, and checkTenancy() (strict) and checkAudit() find nothing; no paid column exists (A8);
//   * done check 1: the golden manual invoice stores its buckets exactly; totals that do not add up are refused;
//   * issued <=> numbered, and the BS date exists only on an issued invoice;
//   * G3: an issued invoice cannot be changed or deleted, nor its lines; lines change only in draft or returned;
//   * G4: one live tax invoice per schedule line (a discarded draft frees it);
//   * credit notes of an invoice never exceed its total (checked at commit), and name an issued tax invoice;
//   * G5 (schema part): a proforma can never get an open item;
//   * a drafted schedule line names an invoice of its own order; no child points at another entity's row (23503);
//   * the print log is append-only.
//
// Setup mirrors quotations.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app, with the acting entity set per transaction like withTx.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import { createParty, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const INVOICING_TABLES = [
  'invoices',
  'invoice_lines',
  'invoice_tax_summary',
  'invoice_print_log',
] as const;

/** The golden SO (SCREENS.md R20): NPR 5,045,450.00 including 13% VAT. */
const GOLDEN = {
  subtotal: '4675000.00',
  discount: '210000.00',
  taxable: '4465000.00',
  tax: '580450.00',
  total: '5045450.00',
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

interface Quote {
  customerPartyId: string;
  quotationId: string;
  versionId: string;
}

/** A quotation of `scope`'s entity with one Draft version (enough for the SO's version FK). */
async function insertQuote(scope: Scope): Promise<Quote> {
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
  return { customerPartyId, quotationId, versionId };
}

const INSERT_SO = `INSERT INTO app.sales_orders
    (tenant_id, organization_id, customer_party_id, quotation_id, quotation_version_id, currency,
     subtotal, discount_amount, taxable_amount, tax_amount, total, fx_rate, amount_npr, credit_days)
  VALUES ($1, $2, $3, $4, $5, 'NPR', $6, $7, $8, $9, $10, 1, $10, 30) RETURNING id`;

function soParams(scope: Scope, quote: Quote, organizationId = scope.organizationId): unknown[] {
  return [
    scope.tenantId,
    organizationId,
    quote.customerPartyId,
    quote.quotationId,
    quote.versionId,
    GOLDEN.subtotal,
    GOLDEN.discount,
    GOLDEN.taxable,
    GOLDEN.tax,
    GOLDEN.total,
  ];
}

/** A draft golden SO on a fresh quote (or on `quote`). */
async function insertSalesOrder(scope: Scope, quote?: Quote): Promise<string> {
  return exec(scope, INSERT_SO, soParams(scope, quote ?? (await insertQuote(scope))));
}

const INSERT_LINE = `INSERT INTO app.billing_schedule_lines
    (tenant_id, organization_id, sales_order_id, seq, label, "trigger", percent, amount, amount_npr, status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) RETURNING id`;

interface Slice {
  label: string;
  trigger: string;
  percent: string;
  amount: string;
  status?: string;
}

function lineParams(scope: Scope, salesOrderId: string, seq: number, s: Slice): unknown[] {
  return [
    scope.tenantId,
    scope.organizationId,
    salesOrderId,
    seq,
    s.label,
    s.trigger,
    s.percent,
    s.amount,
    s.status ?? 'planned',
  ];
}

/** Writes the whole schedule in one transaction (the sum is checked at its commit). */
async function insertSchedule(scope: Scope, salesOrderId: string, slices: Slice[]) {
  return inTx(scope.organizationId, async (c) => {
    const ids: string[] = [];
    for (const [i, s] of slices.entries()) {
      const { rows } = await c.query<{ id: string }>(
        INSERT_LINE,
        lineParams(scope, salesOrderId, i + 1, s),
      );
      ids.push(rows[0]?.id ?? '');
    }
    return ids;
  });
}

const SPLIT_60_20_20: Slice[] = [
  { label: 'Advance 60%', trigger: 'advance', percent: '60', amount: '3027270.00' },
  { label: 'Delivery 20%', trigger: 'delivery', percent: '20', amount: '1009090.00' },
  { label: 'UAT 20%', trigger: 'uat', percent: '20', amount: '1009090.00' },
];

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:invoicing-test'],
    ['bos.correlation_id', 'invoicing-test-0001'],
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

interface Amounts {
  subtotal: string;
  discount: string;
  taxable: string;
  tax: string;
  total: string;
}

/** Done check 1: 1,880,000.00 less 5% (94,000.00) plus 13% VAT (232,180.00) = 2,018,180.00. */
const GOLDEN_INVOICE: Amounts = {
  subtotal: '1880000.00',
  discount: '94000.00',
  taxable: '1786000.00',
  tax: '232180.00',
  total: '2018180.00',
};

/** An amount whose buckets add up with no discount and no tax: subtotal = taxable = total. */
const flat = (total: string): Amounts => ({
  subtotal: total,
  discount: '0.00',
  taxable: total,
  tax: '0.00',
  total,
});

interface InvoiceInput {
  customerPartyId: string;
  kind?: 'tax_invoice' | 'proforma' | 'credit_note' | 'debit_note';
  salesOrderId?: string | null;
  scheduleLineId?: string | null;
  originalInvoiceId?: string | null;
  amounts?: Amounts;
  status?: string;
}

const INSERT_INVOICE = `INSERT INTO app.invoices
    (tenant_id, organization_id, kind, customer_party_id, sales_order_id, schedule_line_id, original_invoice_id,
     manual_reason, note_reason, currency, subtotal, discount_amount, taxable_vat_amount, tax_amount, total, status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'NPR', $10, $11, $12, $13, $14, $15) RETURNING id`;

function invoiceParams(scope: Scope, input: InvoiceInput): unknown[] {
  const kind = input.kind ?? 'tax_invoice';
  const note = kind === 'credit_note' || kind === 'debit_note';
  const a = input.amounts ?? GOLDEN_INVOICE;
  return [
    scope.tenantId,
    scope.organizationId,
    kind,
    input.customerPartyId,
    input.salesOrderId ?? null,
    input.scheduleLineId ?? null,
    input.originalInvoiceId ?? null,
    kind === 'tax_invoice' && !input.salesOrderId ? 'One-off hardware sale' : null,
    note ? 'Price correction agreed with the customer' : null,
    a.subtotal,
    a.discount,
    a.taxable,
    a.tax,
    a.total,
    input.status ?? 'draft',
  ];
}

/** A draft invoice (the golden manual tax invoice by default). */
function insertInvoice(scope: Scope, input: InvoiceInput): Promise<string> {
  return exec(scope, INSERT_INVOICE, invoiceParams(scope, input));
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

async function issuedInvoice(scope: Scope): Promise<{ customer: string; invoice: string }> {
  const customer = await insertCustomer(scope);
  const invoice = await insertInvoice(scope, { customerPartyId: customer });
  await issue(scope, invoice);
  return { customer, invoice };
}

function insertTaxCode(scope: Scope): Promise<string> {
  return exec(
    scope,
    `INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
     VALUES ($1, $2, 'VAT 13%', 'vat', 1300, true, '2026-01-01') RETURNING id`,
    [scope.tenantId, `VAT13-${randomUUID().slice(0, 8)}`],
  );
}

const INSERT_INVOICE_LINE = `INSERT INTO app.invoice_lines
    (tenant_id, organization_id, invoice_id, line_no, description, uom, quantity, unit_price, tax_code_id, gross,
     discount_alloc, taxable)
  VALUES ($1, $2, $3, $4, 'Firewall appliance', 'unit', 1, 1880000.00, $5, 1880000.00, 94000.00, 1786000.00)`;

/** An SO of `scope` with its 60/20/20 schedule; returns the customer, the order and the three line ids. */
async function orderWithSchedule(scope: Scope) {
  const quote = await insertQuote(scope);
  const salesOrderId = await insertSalesOrder(scope, quote);
  const lines = await insertSchedule(scope, salesOrderId, SPLIT_60_20_20);
  return { customer: quote.customerPartyId, salesOrderId, lines };
}

const UUID = /^[0-9a-f-]{36}$/;
const IMMUTABLE = { code: '23514', constraint: 'invoices_issued_immutable_check' };

describe('0021_invoices on a fresh database', () => {
  it('applies, and creates the four tables', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...INVOICING_TABLES]],
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

  it('has no paid or amount_paid column anywhere in schema app (done check 8)', async () => {
    const { rows } = await owner.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND column_name LIKE '%paid%'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('invoice rows', () => {
  it('stores the golden manual invoice exactly (done check 1)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    const id = await insertInvoice(scope, { customerPartyId: customer });
    const { rows } = await app.query(
      `SELECT status, number, subtotal, discount_amount, taxable_vat_amount, tax_amount, total
         FROM app.invoices WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      status: 'draft',
      number: null,
      subtotal: '1880000.00',
      discount_amount: '94000.00',
      taxable_vat_amount: '1786000.00',
      tax_amount: '232180.00',
      total: '2018180.00',
    });
  });

  it('refuses totals that do not add up, and a manual tax invoice without a reason (23514)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    await expect(
      insertInvoice(scope, {
        customerPartyId: customer,
        amounts: { ...GOLDEN_INVOICE, total: '2018180.01' },
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'invoices_total_check' });
    const params = invoiceParams(scope, { customerPartyId: customer });
    params[7] = null;
    await expect(exec(scope, INSERT_INVOICE, params)).rejects.toMatchObject({
      code: '23514',
      constraint: 'invoices_source_check',
    });
  });

  it('is inserted as draft, numbered exactly when issued, and BS-dated only when issued (23514)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    await expect(
      insertInvoice(scope, { customerPartyId: customer, status: 'approved' }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'invoices_insert_draft_check' });
    const id = await insertInvoice(scope, { customerPartyId: customer });
    await expect(
      exec(
        scope,
        `UPDATE app.invoices SET number = 'INV-2083/84-09999', seq = 9999, fiscal_year = '2083/84' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'invoices_issued_check' });
    await expect(
      exec(scope, `UPDATE app.invoices SET issue_date_bs = '2083-07-23' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'invoices_issue_date_bs_check' });
    await expect(
      exec(scope, `UPDATE app.invoices SET status = 'issued' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(issue(scope, id)).resolves.toBeUndefined();
  });
});

describe('G3: an issued invoice is immutable', () => {
  it('refuses any change to an issued invoice, and its deletion, as bos_app (23514)', async () => {
    const scope = await newScope();
    const { invoice } = await issuedInvoice(scope);
    const attempts = [
      `UPDATE app.invoices SET subtotal = 1, discount_amount = 0, taxable_vat_amount = 1, tax_amount = 0, total = 1,
              amount_npr = 1 WHERE id = $1`,
      `UPDATE app.invoices SET buyer_snapshot = '{"name": "Someone else"}' WHERE id = $1`,
      `UPDATE app.invoices SET due_date = '2027-01-31' WHERE id = $1`,
      `UPDATE app.invoices SET manual_reason = 'Edited later' WHERE id = $1`,
      `UPDATE app.invoices SET status = 'draft', number = NULL, seq = NULL, fiscal_year = NULL, issue_date_bs = NULL
        WHERE id = $1`,
    ];
    for (const sql of attempts) {
      await expect(exec(scope, sql, [invoice]), sql).rejects.toMatchObject(IMMUTABLE);
    }
    await expect(
      exec(scope, `DELETE FROM app.invoices WHERE id = $1`, [invoice]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'invoices_frozen_check' });
    // The optimistic lock alone may move (version, updated_at).
    await expect(
      exec(
        scope,
        `UPDATE app.invoices SET version = version + 1, updated_at = now() WHERE id = $1`,
        [invoice],
      ),
    ).resolves.toBe('');
    const { rows } = await app.query(`SELECT status, total FROM app.invoices WHERE id = $1`, [
      invoice,
    ]);
    expect(rows[0]).toEqual({ status: 'issued', total: '2018180.00' });
  });

  it('lets lines change in draft or returned only (23514 when submitted or issued)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    const taxCode = await insertTaxCode(scope);
    const invoice = await insertInvoice(scope, { customerPartyId: customer });
    const line = (no: number) =>
      exec(scope, INSERT_INVOICE_LINE, [
        scope.tenantId,
        scope.organizationId,
        invoice,
        no,
        taxCode,
      ]);
    const frozen = { code: '23514', constraint: 'invoice_lines_frozen_check' };
    await expect(line(1)).resolves.toBe('');
    await exec(scope, `UPDATE app.invoices SET status = 'submitted' WHERE id = $1`, [invoice]);
    await expect(line(2)).rejects.toMatchObject(frozen);
    await exec(scope, `UPDATE app.invoices SET status = 'returned' WHERE id = $1`, [invoice]);
    await expect(line(2)).resolves.toBe('');
    await issue(scope, invoice);
    await expect(line(3)).rejects.toMatchObject(frozen);
    await expect(
      exec(scope, `UPDATE app.invoice_lines SET description = 'Changed' WHERE invoice_id = $1`, [
        invoice,
      ]),
    ).rejects.toMatchObject(frozen);
    await expect(
      exec(scope, `DELETE FROM app.invoice_lines WHERE invoice_id = $1`, [invoice]),
    ).rejects.toMatchObject(frozen);
  });
});

describe('G4: one live tax invoice per schedule line', () => {
  it('refuses a second live tax invoice on a schedule line; a discarded draft frees it (23505)', async () => {
    const scope = await newScope();
    const { customer, salesOrderId, lines } = await orderWithSchedule(scope);
    const input: InvoiceInput = {
      customerPartyId: customer,
      salesOrderId,
      scheduleLineId: lines[0] ?? null,
      amounts: flat('3027270.00'),
    };
    const first = await insertInvoice(scope, input);
    await expect(insertInvoice(scope, input)).rejects.toMatchObject({
      code: '23505',
      constraint: 'invoices_one_live_tax_invoice_per_schedule_line',
    });
    // A proforma for the same line is not a tax invoice.
    await expect(insertInvoice(scope, { ...input, kind: 'proforma' })).resolves.toMatch(UUID);
    await exec(
      scope,
      `UPDATE app.invoices SET status = 'discarded', discarded_at = now() WHERE id = $1`,
      [first],
    );
    await expect(insertInvoice(scope, input)).resolves.toMatch(UUID);
  });

  it('refuses a schedule line of another order (23503)', async () => {
    const scope = await newScope();
    const one = await orderWithSchedule(scope);
    const two = await orderWithSchedule(scope);
    await expect(
      insertInvoice(scope, {
        customerPartyId: one.customer,
        salesOrderId: one.salesOrderId,
        scheduleLineId: two.lines[0] ?? null,
        amounts: flat('3027270.00'),
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'invoices_schedule_line_fk' });
  });
});

describe('credit and debit notes', () => {
  it('refuses, at commit, credit notes that exceed the invoice total (23514)', async () => {
    const scope = await newScope();
    const { customer, invoice } = await issuedInvoice(scope);
    const credit = (total: string) =>
      insertInvoice(scope, {
        customerPartyId: customer,
        kind: 'credit_note',
        originalInvoiceId: invoice,
        amounts: flat(total),
      });
    const cap = { code: '23514', constraint: 'invoices_credit_cap_check' };
    await expect(credit('2018180.01')).rejects.toMatchObject(cap);
    await expect(credit('1000000.00')).resolves.toMatch(UUID);
    await expect(credit('1018180.01')).rejects.toMatchObject(cap);
    const rest = await credit('1018180.00');
    await expect(credit('0.01')).rejects.toMatchObject(cap);
    // Raising a draft credit note past the rest fails too; discarding one frees its share.
    await expect(
      exec(
        scope,
        `UPDATE app.invoices SET subtotal = 1018180.01, taxable_vat_amount = 1018180.01, total = 1018180.01
          WHERE id = $1`,
        [rest],
      ),
    ).rejects.toMatchObject(cap);
    await exec(
      scope,
      `UPDATE app.invoices SET status = 'discarded', discarded_at = now() WHERE id = $1`,
      [rest],
    );
    await expect(credit('1018180.00')).resolves.toMatch(UUID);
  });

  it('needs an issued tax invoice of the same customer as the original (23514)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    const draft = await insertInvoice(scope, { customerPartyId: customer });
    const original = { code: '23514', constraint: 'invoices_note_original_issued_check' };
    for (const kind of ['credit_note', 'debit_note'] as const) {
      await expect(
        insertInvoice(scope, {
          customerPartyId: customer,
          kind,
          originalInvoiceId: draft,
          amounts: flat('10.00'),
        }),
      ).rejects.toMatchObject(original);
    }
    const { invoice } = await issuedInvoice(scope);
    await expect(
      insertInvoice(scope, {
        customerPartyId: customer,
        kind: 'credit_note',
        originalInvoiceId: invoice,
        amounts: flat('10.00'),
      }),
    ).rejects.toMatchObject(original);
  });
});

describe('G5 (schema part): proformas never reach the ledger', () => {
  it('refuses an open item whose source is a proforma (23514)', async () => {
    const scope = await newScope();
    const customer = await insertCustomer(scope);
    await expect(
      exec(
        scope,
        `INSERT INTO app.open_items
           (tenant_id, organization_id, side, direction, customer_party_id, source_type, source_id, currency,
            amount, amount_npr, fx_rate, document_date)
         VALUES ($1, $2, 'receivable', 'debit', $3, 'proforma', $4, 'NPR', 100.00, 100.00, 1, '2026-11-09')`,
        [scope.tenantId, scope.organizationId, customer, randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: expect.stringMatching(/^open_items_source_(type|side)_check$/) as string,
    });
  });
});

describe('schedule line and entity boundaries', () => {
  it('lets a drafted line name an invoice of its own order only (23514 without one, 23503 for another)', async () => {
    const scope = await newScope();
    const one = await orderWithSchedule(scope);
    const two = await orderWithSchedule(scope);
    const invoiceOfOne = await insertInvoice(scope, {
      customerPartyId: one.customer,
      salesOrderId: one.salesOrderId,
      scheduleLineId: one.lines[0] ?? null,
      amounts: flat('3027270.00'),
    });
    const draft = `UPDATE app.billing_schedule_lines SET status = 'drafted', invoice_id = $2 WHERE id = $1`;
    await expect(
      exec(scope, `UPDATE app.billing_schedule_lines SET status = 'drafted' WHERE id = $1`, [
        one.lines[0],
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'billing_schedule_lines_invoice_check' });
    await expect(exec(scope, draft, [two.lines[0], invoiceOfOne])).rejects.toMatchObject({
      code: '23503',
      constraint: 'billing_schedule_lines_invoice_fk',
    });
    await expect(exec(scope, draft, [one.lines[0], invoiceOfOne])).resolves.toBe('');
  });

  it("refuses an invoice, line or note of entity B on entity A's rows (23503)", async () => {
    const a = await newScope();
    const b: Scope = { tenantId: a.tenantId, organizationId: await insertEntity(a.tenantId) };
    const { customer, salesOrderId } = await orderWithSchedule(a);
    await expect(
      insertInvoice(b, { customerPartyId: customer, salesOrderId, amounts: flat('10.00') }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'invoices_sales_order_fk' });
    const issued = await issuedInvoice(a);
    await expect(
      insertInvoice(b, {
        customerPartyId: issued.customer,
        kind: 'credit_note',
        originalInvoiceId: issued.invoice,
        amounts: flat('10.00'),
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'invoices_original_invoice_fk' });
    const draftOfA = await insertInvoice(a, { customerPartyId: issued.customer });
    const taxCode = await insertTaxCode(a);
    await expect(
      exec(b, INSERT_INVOICE_LINE, [b.tenantId, b.organizationId, draftOfA, 1, taxCode]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'invoice_lines_invoice_fk' });
  });
});

describe('print log', () => {
  it('is append-only: bos_app cannot UPDATE or DELETE it, and the trigger refuses the owner', async () => {
    const scope = await newScope();
    const { invoice } = await issuedInvoice(scope);
    const id = await exec(
      scope,
      `INSERT INTO app.invoice_print_log (tenant_id, organization_id, invoice_id, print_no)
       VALUES ($1, $2, $3, 1) RETURNING id`,
      [scope.tenantId, scope.organizationId, invoice],
    );
    await expect(
      exec(scope, `UPDATE app.invoice_print_log SET print_no = 2 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      exec(scope, `DELETE FROM app.invoice_print_log WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      owner.query(`DELETE FROM app.invoice_print_log WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'invoice_print_log_append_only' });
  });
});
