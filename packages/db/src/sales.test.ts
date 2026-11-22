// Integration tests for 0020_sales_orders (P3 unit U1) on a real, empty database of the shared test cluster
// (testing/vitest-global-setup.ts, needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/sales.test.ts
//
// What 0020 must hold, written as bos_app (the API's role) unless a case says otherwise:
//   * the migrations apply, and checkTenancy() (strict) and checkAudit() find nothing;
//   * one live sales order per quotation (a double confirm makes one SO; a cancelled one frees the quotation);
//   * at commit, the live (not cancelled) schedule lines of an order sum to its total: 60/20/20 and 40/60 of the
//     golden SO commit, a split that does not add up is refused, and one transaction may re-split freely;
//   * a drafted or invoiced schedule line names its invoice, and only then;
//   * a child never points at another entity's row (composite FKs, 23503).
//
// Setup mirrors quotations.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app, with the acting entity set per transaction like withTx.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createParty, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const SALES_TABLES = [
  'sales_orders',
  'sales_order_lines',
  'sales_order_tax_summary',
  'sales_order_evidence',
  'billing_schedule_lines',
] as const;

/** The customer address as the schema before 0191 held it (the legacy-billing seed below runs on that schema). */
const LEGACY_ADDRESS = JSON.stringify({ line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' });

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
let migratedSchedule: { scope: Scope; ids: string[] };

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

/** Which customers shape to write: the current one, or the jsonb `address` that 0191 replaced. */
type CustomerShape = 'current' | 'before-0191';

/** A customer party and its customer row (tenant-level). */
async function insertCustomer(scope: Scope, shape: CustomerShape = 'current'): Promise<string> {
  const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind: 'customer' });
  const number = `CUS-${partyId.slice(0, 8)}`;
  if (shape === 'before-0191') {
    await exec(
      scope,
      `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
       VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', $4::jsonb)`,
      [partyId, scope.tenantId, number, LEGACY_ADDRESS],
    );
    return partyId;
  }
  await exec(
    scope,
    `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address_line, address_city)
     VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', 'Durbar Marg 1', 'Kathmandu')`,
    [partyId, scope.tenantId, number],
  );
  return partyId;
}

interface Quote {
  customerPartyId: string;
  quotationId: string;
  versionId: string;
}

/** A quotation of `scope`'s entity with one Draft version (enough for the SO's version FK). */
async function insertQuote(scope: Scope, shape: CustomerShape = 'current'): Promise<Quote> {
  const customerPartyId = await insertCustomer(scope, shape);
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
  percent: string | null;
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

const SUM = { code: '23514', constraint: 'billing_schedule_lines_sum_check' };

beforeAll(async () => {
  // Not migrated: the legacy journal below runs up to 0041 first.
  testDb = await createTestDatabase({ migrated: false });

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:sales-test'],
    ['bos.correlation_id', 'sales-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  const ownerUrl = testDb.ownerUrl;
  owner = new Pool({ connectionString: ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 4 });

  const legacy = mkdtempSync(join(tmpdir(), 'bos-billing-legacy-'));
  try {
    cpSync(MIGRATIONS_FOLDER, legacy, { recursive: true });
    const journalPath = join(legacy, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    const upgrade = journal.entries.findIndex((entry) => entry.tag.startsWith('0042_'));
    expect(upgrade).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, upgrade);
    writeFileSync(journalPath, JSON.stringify(journal));
    await runMigrations(ownerUrl, legacy);

    const scope = await newScope();
    const orderId = await insertSalesOrder(scope, await insertQuote(scope, 'before-0191'));
    const ids = await inTx(scope.organizationId, async (tx) => {
      const basisPoints = ['6000', '1', null];
      const ids: string[] = [];
      for (const [i, slice] of SPLIT_60_20_20.entries()) {
        const { rows } = await tx.query<{ id: string }>(
          INSERT_LINE.replace('percent, amount', 'percent_bp, amount'),
          lineParams(scope, orderId, i + 1, { ...slice, percent: basisPoints[i] ?? null }),
        );
        ids.push(rows[0]!.id);
      }
      return ids;
    });
    migratedSchedule = { scope, ids };
    await runMigrations(ownerUrl);
    await runMigrations(ownerUrl); // A retry must not rescale already converted rows.
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

describe('0020_sales_orders on a fresh database', () => {
  it('applies, and creates the five tables', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...SALES_TABLES]],
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
});

describe('0042 billing schedule percent precision', () => {
  it('converts existing basis points exactly and preserves nulls and allocated amounts', async () => {
    const { scope, ids } = migratedSchedule;
    const result = await inTx(scope.organizationId, (tx) =>
      tx.query(
        'SELECT id, percent, amount, amount_npr FROM app.billing_schedule_lines WHERE id = ANY($1) ORDER BY seq',
        [ids],
      ),
    );
    expect(result.rows).toEqual(
      ['60.0000', '0.0100', null].map((percent, i) => ({
        id: ids[i],
        percent,
        amount: SPLIT_60_20_20[i]!.amount,
        amount_npr: SPLIT_60_20_20[i]!.amount,
      })),
    );
  });

  it('stores all four decimals and enforces the positive percent range', async () => {
    const { scope, ids } = migratedSchedule;
    const write = (percent: string) =>
      inTx(scope.organizationId, (tx) =>
        tx.query(
          'UPDATE app.billing_schedule_lines SET percent = $1 WHERE id = $2 RETURNING percent',
          [percent, ids[0]],
        ),
      );
    await expect(write('33.3334')).resolves.toMatchObject({ rows: [{ percent: '33.3334' }] });
    await expect(write('0.0001')).resolves.toMatchObject({ rows: [{ percent: '0.0001' }] });
    for (const value of ['0', '100.0001']) {
      await expect(write(value)).rejects.toMatchObject({
        code: '23514',
        constraint: 'billing_schedule_lines_percent_check',
      });
    }
  });
});

describe('sales orders', () => {
  it('stores the golden totals exactly and keeps a draft unnumbered', async () => {
    const scope = await newScope();
    const id = await insertSalesOrder(scope);
    const { rows } = await app.query(
      `SELECT status, number, total, taxable_amount, tax_amount, amount_npr FROM app.sales_orders WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      status: 'draft',
      number: null,
      total: GOLDEN.total,
      taxable_amount: GOLDEN.taxable,
      tax_amount: GOLDEN.tax,
      amount_npr: GOLDEN.total,
    });
    await expect(
      exec(scope, `UPDATE app.sales_orders SET number = 'SO-2083/84-00001' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'sales_orders_number_parts_check' });
    await expect(
      exec(scope, `UPDATE app.sales_orders SET status = 'confirmed' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'sales_orders_number_status_check' });
    await expect(
      exec(
        scope,
        `UPDATE app.sales_orders SET status = 'confirmed', confirmed_at = now(),
                number = 'SO-2083/84-00001', seq = 1, fiscal_year = '2083/84' WHERE id = $1`,
        [id],
      ),
    ).resolves.toBe('');
  });

  it('refuses totals that do not add up (23514)', async () => {
    const scope = await newScope();
    const quote = await insertQuote(scope);
    const params = soParams(scope, quote);
    params[9] = '5045450.01';
    await expect(exec(scope, INSERT_SO, params)).rejects.toMatchObject({
      code: '23514',
      constraint: 'sales_orders_total_check',
    });
  });

  it('allows one live sales order per quotation; a cancelled one frees it (23505)', async () => {
    const scope = await newScope();
    const quote = await insertQuote(scope);
    const first = await insertSalesOrder(scope, quote);
    await expect(insertSalesOrder(scope, quote)).rejects.toMatchObject({
      code: '23505',
      constraint: 'sales_orders_one_live_per_quotation',
    });
    await exec(
      scope,
      `UPDATE app.sales_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Duplicate'
        WHERE id = $1`,
      [first],
    );
    await expect(insertSalesOrder(scope, quote)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('billing schedule', () => {
  it('commits 60/20/20 of the golden SO: 3,027,270.00 / 1,009,090.00 / 1,009,090.00', async () => {
    const scope = await newScope();
    const so = await insertSalesOrder(scope);
    await insertSchedule(scope, so, SPLIT_60_20_20);
    const { rows } = await app.query<{ amount: string }>(
      `SELECT amount FROM app.billing_schedule_lines WHERE sales_order_id = $1 ORDER BY seq`,
      [so],
    );
    expect(rows.map((r) => r.amount)).toEqual(['3027270.00', '1009090.00', '1009090.00']);
  });

  it('commits a 40/60 split whose advance is the golden invoice, 2,018,180.00', async () => {
    const scope = await newScope();
    const so = await insertSalesOrder(scope);
    await expect(
      insertSchedule(scope, so, [
        { label: 'Advance 40%', trigger: 'advance', percent: '40', amount: '2018180.00' },
        { label: 'Delivery 60%', trigger: 'delivery', percent: '60', amount: '3027270.00' },
      ]),
    ).resolves.toHaveLength(2);
  });

  it('refuses, at commit, live lines that do not sum to the SO total (23514)', async () => {
    const scope = await newScope();
    const so = await insertSalesOrder(scope);
    await expect(
      insertSchedule(scope, so, [
        { label: 'Advance 60%', trigger: 'advance', percent: '60', amount: '3027270.00' },
        { label: 'Delivery 40%', trigger: 'delivery', percent: '40', amount: '2018179.99' },
      ]),
    ).rejects.toMatchObject(SUM);
    const { rows } = await app.query(
      `SELECT 1 FROM app.billing_schedule_lines WHERE sales_order_id = $1`,
      [so],
    );
    expect(rows).toEqual([]);
  });

  it('checks the sum after an update, a cancel or a delete, but lets one transaction re-split', async () => {
    const scope = await newScope();
    const so = await insertSalesOrder(scope);
    const [advance, delivery, uat] = await insertSchedule(scope, so, SPLIT_60_20_20);
    await expect(
      exec(scope, `UPDATE app.billing_schedule_lines SET amount = 1009089.99 WHERE id = $1`, [uat]),
    ).rejects.toMatchObject(SUM);
    await expect(
      exec(scope, `UPDATE app.billing_schedule_lines SET status = 'cancelled' WHERE id = $1`, [
        uat,
      ]),
    ).rejects.toMatchObject(SUM);
    await expect(
      exec(scope, `DELETE FROM app.billing_schedule_lines WHERE id = $1`, [delivery]),
    ).rejects.toMatchObject(SUM);
    // Re-split 60/20/20 into 60/40 in one transaction: cancel UAT, raise Delivery. Passes through a bad state.
    await inTx(scope.organizationId, async (c) => {
      await c.query(`UPDATE app.billing_schedule_lines SET status = 'cancelled' WHERE id = $1`, [
        uat,
      ]);
      await c.query(
        `UPDATE app.billing_schedule_lines SET amount = 2018180.00, amount_npr = 2018180.00 WHERE id = $1`,
        [delivery],
      );
    });
    const { rows } = await app.query<{ live: string }>(
      `SELECT sum(amount) AS live FROM app.billing_schedule_lines
        WHERE sales_order_id = $1 AND status <> 'cancelled'`,
      [so],
    );
    expect(rows[0]?.live).toBe(GOLDEN.total);
    expect(advance).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a changed SO total that its schedule no longer matches (23514)', async () => {
    const scope = await newScope();
    const so = await insertSalesOrder(scope);
    await insertSchedule(scope, so, SPLIT_60_20_20);
    await expect(
      exec(
        scope,
        `UPDATE app.sales_orders SET tax_amount = 580450.01, total = 5045450.01, amount_npr = 5045450.01
          WHERE id = $1`,
        [so],
      ),
    ).rejects.toMatchObject(SUM);
  });

  it('refuses a drafted or invoiced line without invoice_id, and an invoice_id on a planned line (23514)', async () => {
    const scope = await newScope();
    const so = await insertSalesOrder(scope);
    const invoiceCheck = { code: '23514', constraint: 'billing_schedule_lines_invoice_check' };
    for (const status of ['drafted', 'invoiced']) {
      await expect(
        insertSchedule(
          scope,
          so,
          SPLIT_60_20_20.map((s, i) => (i === 0 ? { ...s, status } : s)),
        ),
      ).rejects.toMatchObject(invoiceCheck);
    }
    const [advance] = await insertSchedule(scope, so, SPLIT_60_20_20);
    await expect(
      exec(scope, `UPDATE app.billing_schedule_lines SET status = 'drafted' WHERE id = $1`, [
        advance,
      ]),
    ).rejects.toMatchObject(invoiceCheck);
    await expect(
      exec(scope, `UPDATE app.billing_schedule_lines SET invoice_id = $2 WHERE id = $1`, [
        advance,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('entity and party boundaries', () => {
  it("refuses a schedule line of entity B on entity A's sales order (23503)", async () => {
    const a = await newScope();
    const b: Scope = { tenantId: a.tenantId, organizationId: await insertEntity(a.tenantId) };
    const soOfA = await insertSalesOrder(a);
    await expect(
      exec(
        b,
        INSERT_LINE,
        lineParams(b, soOfA, 1, { ...SPLIT_60_20_20[0]!, amount: GOLDEN.total }),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'billing_schedule_lines_sales_order_fk' });
  });

  it("refuses a sales order of entity B on entity A's quotation version (23503)", async () => {
    const a = await newScope();
    const b: Scope = { tenantId: a.tenantId, organizationId: await insertEntity(a.tenantId) };
    const quoteOfA = await insertQuote(a);
    await expect(exec(b, INSERT_SO, soParams(b, quoteOfA))).rejects.toMatchObject({
      code: '23503',
      constraint: 'sales_orders_quotation_version_fk',
    });
  });

  it("refuses a version of another quotation, and a line or evidence of another entity's SO (23503)", async () => {
    const a = await newScope();
    const b: Scope = { tenantId: a.tenantId, organizationId: await insertEntity(a.tenantId) };
    const q1 = await insertQuote(a);
    const q2 = await insertQuote(a);
    await expect(
      exec(a, INSERT_SO, soParams(a, { ...q1, versionId: q2.versionId })),
    ).rejects.toMatchObject({ code: '23503', constraint: 'sales_orders_quotation_version_fk' });
    const soOfA = await insertSalesOrder(a, q1);
    const taxCode = await exec(
      a,
      `INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
       VALUES ($1, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2026-01-01') RETURNING id`,
      [a.tenantId],
    );
    await expect(
      exec(
        b,
        `INSERT INTO app.sales_order_lines
           (tenant_id, organization_id, sales_order_id, line_no, description, uom, quantity, unit_price,
            tax_code_id, gross, discount_alloc, taxable)
         VALUES ($1, $2, $3, 1, 'Design', 'hour', 1, 100.00, $4, 100.00, 0, 100.00)`,
        [b.tenantId, b.organizationId, soOfA, taxCode],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'sales_order_lines_sales_order_fk' });
  });

  it('refuses a vendor party as the customer (23503)', async () => {
    const scope = await newScope();
    const quote = await insertQuote(scope);
    const { partyId: vendor } = await createParty(app, {
      tenantId: scope.tenantId,
      kind: 'vendor',
    });
    await expect(
      exec(scope, INSERT_SO, soParams(scope, { ...quote, customerPartyId: vendor })),
    ).rejects.toMatchObject({ code: '23503', constraint: 'sales_orders_customer_party_fk' });
  });
});
