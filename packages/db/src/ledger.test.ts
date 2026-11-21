// Integration tests for 0019_open_items (P3 unit U0-A) on a real, empty postgres:16-alpine started by Testcontainers
// (needs Docker). Run with: pnpm --filter @bos/db exec vitest run src/ledger.test.ts
//
// What 0019 must hold, written as bos_app (the API's role) unless a case says otherwise:
//   * the migrations apply, and checkTenancy() (strict) and checkAudit() find nothing;
//   * open items, allocations and posting events are append-only: bos_app cannot UPDATE or DELETE them, and the
//     trigger refuses even the owner; bos_app can still lock an open item with SELECT ... FOR UPDATE;
//   * one open item per source document, and one posting event per source and event;
//   * the counterparty matches the side: a customer on a receivable, a vendor on a payable, never both;
//   * an allocation pairs a debit with a credit of the same side, party and currency;
//   * at commit, no item is allocated beyond its amount (the check is deferred, so a transaction may pass through an
//     over-allocated state and repair it), counting other transactions' committed allocations;
//   * a reversal undoes one allocation once, and open_item_balances shows the derived open amount;
//   * withholding-code periods of one code never overlap.
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

const LEDGER_RELATIONS = [
  'withholding_codes',
  'open_items',
  'open_item_allocations',
  'posting_events',
  'open_item_balances',
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

async function party(scope: Scope, kind: 'customer' | 'vendor'): Promise<string> {
  const { partyId } = await createParty(app, { tenantId: scope.tenantId, kind });
  return partyId;
}

interface ItemInput {
  side?: 'receivable' | 'payable';
  direction: 'debit' | 'credit';
  sourceType: string;
  amount: string;
  customerPartyId?: string | null;
  vendorPartyId?: string | null;
  currency?: 'NPR' | 'USD';
  sourceId?: string;
}

const INSERT_ITEM = `INSERT INTO app.open_items
    (tenant_id, organization_id, side, direction, customer_party_id, vendor_party_id, source_type, source_id,
     currency, amount, amount_npr, fx_rate, fx_source, fx_date, document_date, due_date)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric,
          ($10::numeric * $11::numeric)::numeric(18, 2), $11, $12, $13, '2026-11-09', NULL)
  RETURNING id`;

function itemParams(scope: Scope, input: ItemInput): unknown[] {
  const usd = input.currency === 'USD';
  return [
    scope.tenantId,
    scope.organizationId,
    input.side ?? 'receivable',
    input.direction,
    input.customerPartyId ?? null,
    input.vendorPartyId ?? null,
    input.sourceType,
    input.sourceId ?? randomUUID(),
    input.currency ?? 'NPR',
    input.amount,
    usd ? '133.500000' : '1',
    usd ? 'NRB' : null,
    usd ? '2026-11-09' : null,
  ];
}

function insertItem(scope: Scope, input: ItemInput): Promise<string> {
  return exec(scope, INSERT_ITEM, itemParams(scope, input));
}

const INSERT_ALLOCATION = `INSERT INTO app.open_item_allocations
    (tenant_id, organization_id, debit_item_id, credit_item_id, amount, reverses_allocation_id, reason)
  VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;

function allocationParams(
  scope: Scope,
  debitItemId: string,
  creditItemId: string,
  amount: string,
  reverses: string | null = null,
): unknown[] {
  return [
    scope.tenantId,
    scope.organizationId,
    debitItemId,
    creditItemId,
    amount,
    reverses,
    reverses === null ? null : 'Payment allocated to the wrong invoice',
  ];
}

function allocate(
  scope: Scope,
  debitItemId: string,
  creditItemId: string,
  amount: string,
  reverses: string | null = null,
): Promise<string> {
  return exec(
    scope,
    INSERT_ALLOCATION,
    allocationParams(scope, debitItemId, creditItemId, amount, reverses),
  );
}

async function balance(itemId: string): Promise<{ allocated: string; open: string }> {
  const { rows } = await app.query<{ allocated: string; open: string }>(
    `SELECT allocated_amount AS allocated, open_amount AS open
       FROM app.open_item_balances WHERE open_item_id = $1`,
    [itemId],
  );
  if (rows[0] === undefined) throw new Error(`no balance row for ${itemId}`);
  return rows[0];
}

/** A receivable pair for one customer: a tax invoice (debit) and a verified payment (credit), NPR. */
async function receivablePair(
  invoiceAmount = '1000.00',
  paymentAmount = '2000.00',
): Promise<{ scope: Scope; customer: string; invoice: string; payment: string }> {
  const scope = await newScope();
  const customer = await party(scope, 'customer');
  const invoice = await insertItem(scope, {
    direction: 'debit',
    sourceType: 'tax_invoice',
    amount: invoiceAmount,
    customerPartyId: customer,
  });
  const payment = await insertItem(scope, {
    direction: 'credit',
    sourceType: 'payment',
    amount: paymentAmount,
    customerPartyId: customer,
  });
  return { scope, customer, invoice, payment };
}

const CAP = { code: '23514', constraint: 'open_item_allocations_cap_check' };
const MATCH = { code: '23514', constraint: 'open_item_allocations_match_check' };
const DENIED = { code: '42501' };

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:ledger-test'],
    ['bos.correlation_id', 'ledger-test-0001'],
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

describe('0019_open_items on a fresh database', () => {
  it('applies, and creates the four tables and the balance view', async () => {
    const { rows } = await owner.query<{ name: string; oid: string | null }>(
      `SELECT t AS name, to_regclass('app.' || t)::text AS oid FROM unnest($1::text[]) AS t`,
      [[...LEDGER_RELATIONS]],
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

describe('append-only', () => {
  it('refuses UPDATE and DELETE of every ledger table to bos_app (42501)', async () => {
    const { scope, invoice, payment } = await receivablePair();
    const allocation = await allocate(scope, invoice, payment, '100.00');
    const event = await exec(
      scope,
      `INSERT INTO app.posting_events (tenant_id, organization_id, source_type, source_id, event, payload)
       VALUES ($1, $2, 'tax_invoice', $3, 'invoice_issued', '{"total": "1000.00"}') RETURNING id`,
      [scope.tenantId, scope.organizationId, randomUUID()],
    );

    const attempts: [string, string][] = [
      ['UPDATE app.open_items SET amount = 1 WHERE id = $1', invoice],
      ['DELETE FROM app.open_items WHERE id = $1', invoice],
      ['UPDATE app.open_item_allocations SET amount = 1 WHERE id = $1', allocation],
      ['DELETE FROM app.open_item_allocations WHERE id = $1', allocation],
      [`UPDATE app.posting_events SET payload = '{}' WHERE id = $1`, event],
      ['DELETE FROM app.posting_events WHERE id = $1', event],
    ];
    for (const [sql, id] of attempts) {
      await expect(exec(scope, sql, [id]), sql).rejects.toMatchObject(DENIED);
    }
    expect(await balance(invoice)).toEqual({ allocated: '100.00', open: '900.00' });
  });

  it('refuses them by trigger too (23514), even where a privilege allows the statement', async () => {
    const { scope, invoice, payment } = await receivablePair();
    const allocation = await allocate(scope, invoice, payment, '100.00');
    // bos_app holds UPDATE on open_items.id only so it can lock rows; the trigger still refuses the UPDATE.
    await expect(
      exec(scope, 'UPDATE app.open_items SET id = id WHERE id = $1', [invoice]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'open_items_append_only' });
    // The owner has every privilege, and the trigger refuses it as well.
    await expect(
      owner.query('DELETE FROM app.open_item_allocations WHERE id = $1', [allocation]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'open_item_allocations_append_only' });
    await expect(
      owner.query('UPDATE app.open_items SET amount = 5000 WHERE id = $1', [invoice]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'open_items_append_only' });
  });

  it('still lets bos_app lock an open item with SELECT ... FOR UPDATE', async () => {
    const { scope, invoice } = await receivablePair();
    const locked = await inTx(scope.organizationId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        'SELECT id FROM app.open_items WHERE id = $1 FOR UPDATE',
        [invoice],
      );
      return rows.map((r) => r.id);
    });
    expect(locked).toEqual([invoice]);
  });
});

describe('one row per source', () => {
  it('refuses a second open item for the same source document (23505)', async () => {
    const scope = await newScope();
    const customer = await party(scope, 'customer');
    const sourceId = randomUUID();
    const item: ItemInput = {
      direction: 'debit',
      sourceType: 'tax_invoice',
      amount: '1000.00',
      customerPartyId: customer,
      sourceId,
    };
    await insertItem(scope, item);
    await expect(insertItem(scope, { ...item, amount: '999.00' })).rejects.toMatchObject({
      code: '23505',
      constraint: 'open_items_tenant_org_source_unique',
    });
    // The same id under another source type is another document.
    await expect(
      insertItem(scope, { ...item, direction: 'credit', sourceType: 'credit_note' }),
    ).resolves.toBeTypeOf('string');
  });

  it('refuses a second posting event of one kind for one source (23505)', async () => {
    const scope = await newScope();
    const sourceId = randomUUID();
    const insert = (event: string) =>
      exec(
        scope,
        `INSERT INTO app.posting_events (tenant_id, organization_id, source_type, source_id, event)
         VALUES ($1, $2, 'payment', $3, $4) RETURNING id`,
        [scope.tenantId, scope.organizationId, sourceId, event],
      );
    await insert('payment_verified');
    await expect(insert('payment_verified')).rejects.toMatchObject({
      code: '23505',
      constraint: 'posting_events_tenant_org_source_event_unique',
    });
    await expect(insert('payment_reversed')).resolves.toBeTypeOf('string');
  });
});

describe('counterparty and side', () => {
  it('requires exactly the party column of the side (23514)', async () => {
    const scope = await newScope();
    const customer = await party(scope, 'customer');
    const vendor = await party(scope, 'vendor');
    const mismatch = { code: '23514', constraint: 'open_items_party_side_check' };

    // A receivable names a vendor, a payable names a customer, or an item names both or neither.
    await expect(
      insertItem(scope, {
        direction: 'debit',
        sourceType: 'tax_invoice',
        amount: '10.00',
        vendorPartyId: vendor,
      }),
    ).rejects.toMatchObject(mismatch);
    await expect(
      insertItem(scope, {
        side: 'payable',
        direction: 'credit',
        sourceType: 'vendor_bill',
        amount: '10.00',
        customerPartyId: customer,
      }),
    ).rejects.toMatchObject(mismatch);
    await expect(
      insertItem(scope, {
        direction: 'debit',
        sourceType: 'tax_invoice',
        amount: '10.00',
        customerPartyId: customer,
        vendorPartyId: vendor,
      }),
    ).rejects.toMatchObject(mismatch);
    await expect(
      insertItem(scope, { direction: 'debit', sourceType: 'tax_invoice', amount: '10.00' }),
    ).rejects.toMatchObject(mismatch);

    // The right column must also hold a party of that kind.
    await expect(
      insertItem(scope, {
        direction: 'debit',
        sourceType: 'tax_invoice',
        amount: '10.00',
        customerPartyId: vendor,
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'open_items_customer_party_fk' });

    // A vendor bill on the payable side is fine.
    await expect(
      insertItem(scope, {
        side: 'payable',
        direction: 'credit',
        sourceType: 'vendor_bill',
        amount: '10.00',
        vendorPartyId: vendor,
      }),
    ).resolves.toBeTypeOf('string');
  });
});

describe('allocation matching', () => {
  it('refuses a cross-party or cross-currency allocation (23514)', async () => {
    const { scope, customer, invoice } = await receivablePair();
    const otherCustomer = await party(scope, 'customer');
    const otherPayment = await insertItem(scope, {
      direction: 'credit',
      sourceType: 'payment',
      amount: '500.00',
      customerPartyId: otherCustomer,
    });
    await expect(allocate(scope, invoice, otherPayment, '100.00')).rejects.toMatchObject(MATCH);

    const usdPayment = await insertItem(scope, {
      direction: 'credit',
      sourceType: 'payment',
      amount: '50.00',
      currency: 'USD',
      customerPartyId: customer,
    });
    await expect(allocate(scope, invoice, usdPayment, '10.00')).rejects.toMatchObject(MATCH);
    expect(await balance(invoice)).toEqual({ allocated: '0.00', open: '1000.00' });
  });

  it('refuses a credit item in the debit position (23514)', async () => {
    const { scope, invoice, payment } = await receivablePair();
    await expect(allocate(scope, payment, invoice, '100.00')).rejects.toMatchObject({
      code: '23514',
      constraint: 'open_item_allocations_direction_check',
    });
  });
});

describe('allocation cap (deferred to commit)', () => {
  it('accepts the INSERT of an over-allocation and refuses the COMMIT (23514)', async () => {
    const { scope, invoice, payment } = await receivablePair('1000.00', '2000.00');
    await expect(
      inTx(scope.organizationId, async (c) => {
        // The statement itself succeeds: the cap is checked only when the transaction commits.
        await expect(
          c.query(INSERT_ALLOCATION, allocationParams(scope, invoice, payment, '1000.01')),
        ).resolves.toBeDefined();
      }),
    ).rejects.toMatchObject(CAP);
    expect(await balance(invoice)).toEqual({ allocated: '0.00', open: '1000.00' });
  });

  it('caps the credit item too: a 500.00 payment cannot settle 600.00', async () => {
    const { scope, invoice, payment } = await receivablePair('1000.00', '500.00');
    await expect(allocate(scope, invoice, payment, '600.00')).rejects.toMatchObject(CAP);
    await expect(allocate(scope, invoice, payment, '500.00')).resolves.toBeTypeOf('string');
    expect(await balance(payment)).toEqual({ allocated: '500.00', open: '0.00' });
    expect(await balance(invoice)).toEqual({ allocated: '500.00', open: '500.00' });
  });

  it('lets one transaction pass through an over-allocated state and repair it before commit', async () => {
    const { scope, invoice, payment } = await receivablePair('1000.00', '2000.00');
    await inTx(scope.organizationId, async (c) => {
      await c.query(INSERT_ALLOCATION, allocationParams(scope, invoice, payment, '800.00'));
      const { rows } = await c.query<{ id: string }>(
        INSERT_ALLOCATION,
        allocationParams(scope, invoice, payment, '400.00'),
      );
      // 1,200.00 of 1,000.00 is allocated here; the reversal brings it back to 800.00 before COMMIT.
      await c.query(
        INSERT_ALLOCATION,
        allocationParams(scope, invoice, payment, '-400.00', rows[0]?.id ?? null),
      );
    });
    expect(await balance(invoice)).toEqual({ allocated: '800.00', open: '200.00' });
  });

  it("counts another transaction's committed allocations", async () => {
    const { scope, invoice, payment } = await receivablePair('1000.00', '2000.00');
    const first = await app.connect();
    const second = await app.connect();
    try {
      for (const c of [first, second]) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('bos.organization_id', $1, true)`, [scope.organizationId]);
      }
      await first.query(INSERT_ALLOCATION, allocationParams(scope, invoice, payment, '600.00'));
      // The audit chain's per-tenant advisory lock makes this INSERT wait for the first transaction, so it is
      // started, not awaited, before the first one commits.
      const secondInsert = second.query(
        INSERT_ALLOCATION,
        allocationParams(scope, invoice, payment, '600.00'),
      );
      await first.query('COMMIT');
      await secondInsert;
      await expect(second.query('COMMIT')).rejects.toMatchObject(CAP);
    } finally {
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
    expect(await balance(invoice)).toEqual({ allocated: '600.00', open: '400.00' });
  });
});

describe('reversal and open_item_balances', () => {
  it('derives the open amount, and a reversal restores it once', async () => {
    const { scope, invoice, payment } = await receivablePair('1000.00', '2000.00');
    expect(await balance(invoice)).toEqual({ allocated: '0.00', open: '1000.00' });

    const allocation = await allocate(scope, invoice, payment, '400.00');
    expect(await balance(invoice)).toEqual({ allocated: '400.00', open: '600.00' });
    expect(await balance(payment)).toEqual({ allocated: '400.00', open: '1600.00' });

    // A reversal must be exactly the negative of the original, on the same items.
    await expect(allocate(scope, invoice, payment, '-300.00', allocation)).rejects.toMatchObject({
      code: '23514',
      constraint: 'open_item_allocations_reversal_check',
    });
    // A negative amount is only a reversal.
    await expect(allocate(scope, invoice, payment, '-400.00')).rejects.toMatchObject({
      code: '23514',
      constraint: 'open_item_allocations_reversal_sign_check',
    });

    await allocate(scope, invoice, payment, '-400.00', allocation);
    expect(await balance(invoice)).toEqual({ allocated: '0.00', open: '1000.00' });
    expect(await balance(payment)).toEqual({ allocated: '0.00', open: '2000.00' });

    await expect(allocate(scope, invoice, payment, '-400.00', allocation)).rejects.toMatchObject({
      code: '23505',
      constraint: 'open_item_allocations_tenant_reverses_unique',
    });
    expect(await balance(invoice)).toEqual({ allocated: '0.00', open: '1000.00' });
  });
});

describe('withholding codes', () => {
  it('refuse an overlapping period for the same code (23P01), and allow adjacent ones', async () => {
    const scope = await newScope();
    const insert = (code: string, from: string, to: string | null) =>
      exec(
        scope,
        `INSERT INTO app.withholding_codes (tenant_id, code, name, applies_to, rate_bp, effective_from, effective_to)
         VALUES ($1, $2, 'TDS on services', 'both', 0, $3, $4) RETURNING id`,
        [scope.tenantId, code, from, to],
      );
    await insert('TDS_SERVICE', '2020-01-01', '2026-07-17');
    await expect(insert('TDS_SERVICE', '2026-07-17', null)).resolves.toBeTypeOf('string');
    await expect(insert('TDS_SERVICE', '2026-07-16', '2026-07-18')).rejects.toMatchObject({
      code: '23P01',
      constraint: 'withholding_codes_no_overlap',
    });
    await expect(insert('TDS_GOODS', '2020-01-01', null)).resolves.toBeTypeOf('string');
  });
});
