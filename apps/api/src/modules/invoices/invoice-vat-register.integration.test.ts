// Integration tests of the sales VAT register (round 5, K1) on a real Postgres: every migration, queries as bos_app,
// InvoiceVatRegisterService, withTx and the invoices table with its guards. Faked: the request context (InvoiceCaller).
// What they pin: only issued tax invoices, credit notes and debit notes of the period appear; credit notes are negative,
// debit notes positive; totals are per currency and never mixed; the acting entity and tenant scope the rows; the buyer
// name, PAN and BS date come from the frozen issue snapshot.
// Run: pnpm --filter @bos/api exec vitest run src/modules/invoices/invoice-vat-register.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { SalesVatRegisterSchema } from '@bos/contracts';
import { createParty, createTenantWithEntity, organizations } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import { InvoiceVatRegisterService } from './invoice-vat-register.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;

interface Tenant extends TxScope {
  customerId: string;
}
let a: Tenant;
let entityA2: string;
let b: Tenant;

const current = { scope: undefined as unknown as TxScope };
const caller = {
  current: () => ({
    scope: current.scope,
    actor: { kind: 'user' as const, id: randomUUID(), correlationId: 'test-corr' },
    principal: {} as Principal,
  }),
};
const service = () => new InvoiceVatRegisterService(db, caller);

let seq = 0;
interface Doc {
  scope: TxScope;
  customerId: string;
  kind?: 'tax_invoice' | 'credit_note' | 'debit_note' | 'proforma';
  status?: 'issued' | 'draft';
  currency?: 'NPR' | 'USD' | 'INR';
  /** The frozen NPR rate of a foreign document; 133 when not given. */
  rate?: string;
  issueDate: string;
  bs?: string;
  taxable: string;
  vat: string;
  exempt?: string;
  zero?: string;
  buyer?: { legalName: string; panVatNo: string | null };
  originalId?: string;
}

/** An invoice written the way the app does: a draft row, then one UPDATE that issues it with its snapshots. */
async function document(d: Doc): Promise<string> {
  const kind = d.kind ?? 'tax_invoice';
  const n = (seq += 1);
  const exempt = d.exempt ?? '0.00';
  const zero = d.zero ?? '0.00';
  const subtotal = (Number(d.taxable) + Number(exempt) + Number(zero)).toFixed(2);
  const total = (Number(subtotal) + Number(d.vat)).toFixed(2);
  const currency = d.currency ?? 'NPR';
  const { tenantId, organizationId } = d.scope;
  return withTx(db, d.scope, systemActor('test'), async (tx) => {
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.invoices
        (tenant_id, organization_id, kind, customer_party_id, manual_reason, original_invoice_id, note_reason,
         currency, subtotal, discount_amount, taxable_vat_amount, exempt_amount, zero_rated_amount, tax_amount,
         total, due_date)
      VALUES (${tenantId}::uuid, ${organizationId}::uuid, ${kind}, ${d.customerId}::uuid,
              ${kind === 'tax_invoice' || kind === 'proforma' ? 'integration test' : null},
              ${d.originalId ?? null}::uuid, ${d.originalId === undefined ? null : 'correction'},
              ${currency}, ${subtotal}, 0, ${d.taxable}, ${exempt}, ${zero}, ${d.vat}, ${total}, '2027-12-31')
      RETURNING id`);
    const id = inserted.rows[0]!.id;
    if ((d.status ?? 'issued') === 'issued') {
      const buyer = d.buyer ?? { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: '301234567' };
      await tx.execute(sql`
        UPDATE app.invoices
           SET status = 'issued', number = ${`INV-T-${String(n).padStart(5, '0')}`}, seq = ${n},
               fiscal_year = '2083/84', issue_date = ${d.issueDate}::date, issue_date_bs = ${d.bs ?? '2083-07-20'},
               issued_at = now(), fx_rate = ${currency === 'NPR' ? '1' : (d.rate ?? '133')}::numeric,
               fx_source = ${currency === 'NPR' ? null : 'test'}, fx_date = ${currency === 'NPR' ? null : d.issueDate}::date,
               amount_npr = ${currency === 'NPR' ? total : sql`round(${total}::numeric * ${d.rate ?? '133'}::numeric, 2)`}::numeric,
               seller_snapshot = '{"legalName":"Techrida"}'::jsonb,
               buyer_snapshot = ${JSON.stringify(buyer)}::jsonb,
               content_hash = decode(repeat('ab', 32), 'hex')
         WHERE id = ${id}::uuid`);
    }
    return id;
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
  db = drizzle({ client: appPool });
  const tenant = async (code: string): Promise<Tenant> => {
    const t = await createTenantWithEntity(appPool, { code, name: `Entity ${code}` });
    const { partyId } = await createParty(appPool, { tenantId: t.tenantId, kind: 'customer' });
    await withTx(db, t, systemActor('test'), (tx) =>
      tx.execute(sql`
        INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
        VALUES (${partyId}::uuid, ${t.tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`}, 'Himal Traders',
                'himal traders', '{"line1":"Thamel 4","country":"NP"}'::jsonb)`),
    );
    return { tenantId: t.tenantId, organizationId: t.organizationId, customerId: partyId };
  };
  a = await tenant('VA');
  b = await tenant('VB');
  entityA2 = randomUUID();
  await withTx(db, a, systemActor('test'), (tx) =>
    tx.insert(organizations).values({
      id: entityA2,
      tenantId: a.tenantId,
      organizationId: entityA2,
      code: 'VA2',
      name: 'Second entity',
      legalName: 'Second entity',
    }),
  );
});

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('GET /v1/invoices/vat-register (InvoiceVatRegisterService)', () => {
  it('lists issued tax invoices, credit notes (negative) and debit notes of the period, with per-currency totals', async () => {
    const scope: TxScope = { tenantId: a.tenantId, organizationId: a.organizationId };
    const base = { scope, customerId: a.customerId };
    const original = await document({
      ...base,
      issueDate: '2026-11-02',
      bs: '2083-07-16',
      taxable: '1000.00',
      vat: '130.00',
      exempt: '300.00',
      zero: '200.00',
    });
    await document({
      ...base,
      issueDate: '2026-11-10',
      bs: '2083-07-24',
      taxable: '50.50',
      vat: '6.57',
      buyer: { legalName: '=HYPERLINK("http://evil")', panVatNo: null },
    });
    await document({
      ...base,
      kind: 'credit_note',
      originalId: original,
      issueDate: '2026-11-12',
      bs: '2083-07-26',
      taxable: '100.00',
      vat: '13.00',
    });
    await document({
      ...base,
      kind: 'debit_note',
      originalId: original,
      issueDate: '2026-11-15',
      bs: '2083-07-29',
      taxable: '40.00',
      vat: '5.20',
    });
    await document({
      ...base,
      currency: 'USD',
      issueDate: '2026-11-20',
      bs: '2083-08-04',
      taxable: '200.00',
      vat: '26.00',
    });
    // Not in the register: a proforma, a draft, an issued invoice outside the period, and the other entity and tenant.
    await document({
      ...base,
      kind: 'proforma',
      issueDate: '2026-11-03',
      taxable: '999.00',
      vat: '99.00',
    });
    await document({
      ...base,
      status: 'draft',
      issueDate: '2026-11-03',
      taxable: '998.00',
      vat: '98.00',
    });
    await document({ ...base, issueDate: '2026-10-31', taxable: '997.00', vat: '97.00' });
    await document({ ...base, issueDate: '2026-12-01', taxable: '996.00', vat: '96.00' });
    await document({
      scope: { tenantId: a.tenantId, organizationId: entityA2 },
      customerId: a.customerId,
      issueDate: '2026-11-05',
      taxable: '995.00',
      vat: '95.00',
    });
    await document({
      scope: { tenantId: b.tenantId, organizationId: b.organizationId },
      customerId: b.customerId,
      issueDate: '2026-11-05',
      taxable: '994.00',
      vat: '94.00',
    });

    current.scope = scope;
    const register = SalesVatRegisterSchema.parse(
      await service().register('2026-11-01', '2026-11-30'),
    );

    expect(
      register.rows.map((r) => [r.issueDate, r.kind, r.currency, r.taxableAmount, r.vatAmount]),
    ).toEqual([
      ['2026-11-02', 'tax_invoice', 'NPR', '1000.00', '130.00'],
      ['2026-11-10', 'tax_invoice', 'NPR', '50.50', '6.57'],
      ['2026-11-12', 'credit_note', 'NPR', '-100.00', '-13.00'],
      ['2026-11-15', 'debit_note', 'NPR', '40.00', '5.20'],
      ['2026-11-20', 'tax_invoice', 'USD', '200.00', '26.00'],
    ]);
    const first = register.rows[0]!;
    expect(first).toMatchObject({
      issueDateBs: '2083-07-16',
      buyerName: 'Himal Traders Pvt. Ltd.',
      buyerPan: '301234567',
      exemptAmount: '300.00',
      zeroRatedAmount: '200.00',
      totalAmount: '1630.00',
    });
    expect(register.rows[1]!.buyerPan).toBeNull();
    expect(register.rows[2]).toMatchObject({ exemptAmount: '0.00', totalAmount: '-113.00' });
    // NPR: 1000 + 50.50 - 100 + 40 = 990.50; VAT 130 + 6.57 - 13 + 5.20 = 128.77. USD stays apart.
    expect(register.totals).toEqual([
      {
        currency: 'NPR',
        documents: 4,
        taxableAmount: '990.50',
        vatAmount: '128.77',
        exemptAmount: '300.00',
        zeroRatedAmount: '200.00',
        totalAmount: '1619.27',
      },
      {
        currency: 'USD',
        documents: 1,
        taxableAmount: '200.00',
        vatAmount: '26.00',
        exemptAmount: '0.00',
        zeroRatedAmount: '0.00',
        totalAmount: '226.00',
      },
    ]);
  });

  it('gives every row its NPR equivalents at the rate frozen at issue, and one NPR filing total that adds up across NPR, USD and INR (FU11)', async () => {
    const scope: TxScope = { tenantId: a.tenantId, organizationId: a.organizationId };
    const base = { scope, customerId: a.customerId };
    await document({
      ...base,
      issueDate: '2027-03-02',
      taxable: '1000.00',
      vat: '130.00',
      exempt: '300.00',
      zero: '200.00',
    });
    const usd = await document({
      ...base,
      currency: 'USD',
      rate: '133.5',
      issueDate: '2027-03-05',
      taxable: '33.33',
      vat: '4.33',
    });
    await document({
      ...base,
      currency: 'INR',
      rate: '1.6',
      issueDate: '2027-03-09',
      taxable: '1000.00',
      vat: '130.00',
      exempt: '250.50',
    });
    await document({
      ...base,
      kind: 'credit_note',
      originalId: usd,
      currency: 'USD',
      rate: '133.5',
      issueDate: '2027-03-12',
      taxable: '10.00',
      vat: '1.30',
    });

    current.scope = scope;
    const register = SalesVatRegisterSchema.parse(
      await service().register('2027-03-01', '2027-03-31'),
    );

    // Each amount times the frozen rate, half-up to 2 decimals; a credit note is negative; the total is the frozen amount_npr.
    expect(
      register.rows.map((r) => [
        r.currency,
        r.fxRate,
        r.nprTaxableAmount,
        r.nprVatAmount,
        r.nprExemptAmount,
        r.nprZeroRatedAmount,
        r.nprTotalAmount,
      ]),
    ).toEqual([
      ['NPR', '1.000000', '1000.00', '130.00', '300.00', '200.00', '1630.00'],
      ['USD', '133.500000', '4449.56', '578.06', '0.00', '0.00', '5027.61'],
      ['INR', '1.600000', '1600.00', '208.00', '400.80', '0.00', '2208.80'],
      ['USD', '133.500000', '-1335.00', '-173.55', '0.00', '0.00', '-1508.55'],
    ]);
    // The per-currency totals stay as they were, in each document's own currency.
    expect(
      register.totals.map((t) => [
        t.currency,
        t.documents,
        t.taxableAmount,
        t.vatAmount,
        t.totalAmount,
      ]),
    ).toEqual([
      ['NPR', 1, '1000.00', '130.00', '1630.00'],
      ['INR', 1, '1000.00', '130.00', '1380.50'],
      ['USD', 2, '23.33', '3.03', '26.36'],
    ]);
    // The NPR filing total: 1000 + 4449.56 + 1600 - 1335 = 5714.56 and so on, and it is exactly the sum of the rows.
    expect(register.nprTotal).toEqual({
      documents: 4,
      taxableAmount: '5714.56',
      vatAmount: '742.51',
      exemptAmount: '700.80',
      zeroRatedAmount: '200.00',
      totalAmount: '7357.86',
    });
    const sum = (pick: (r: (typeof register.rows)[number]) => string) =>
      register.rows.reduce((acc, r) => acc.plus(pick(r)), new Decimal(0)).toFixed(2);
    expect(register.nprTotal.taxableAmount).toBe(sum((r) => r.nprTaxableAmount));
    expect(register.nprTotal.vatAmount).toBe(sum((r) => r.nprVatAmount));
    expect(register.nprTotal.exemptAmount).toBe(sum((r) => r.nprExemptAmount));
    expect(register.nprTotal.zeroRatedAmount).toBe(sum((r) => r.nprZeroRatedAmount));
    expect(register.nprTotal.totalAmount).toBe(sum((r) => r.nprTotalAmount));
  });

  it('is scoped to the acting entity and tenant, and an empty period is an empty register', async () => {
    current.scope = { tenantId: a.tenantId, organizationId: entityA2 };
    const other = await service().register('2026-11-01', '2026-11-30');
    expect(other.rows.map((r) => r.taxableAmount)).toEqual(['995.00']);
    current.scope = { tenantId: b.tenantId, organizationId: b.organizationId };
    expect(
      (await service().register('2026-11-01', '2026-11-30')).rows.map((r) => r.taxableAmount),
    ).toEqual(['994.00']);
    expect(await service().register('2030-01-01', '2030-01-31')).toEqual({
      from: '2030-01-01',
      to: '2030-01-31',
      rows: [],
      totals: [],
      nprTotal: {
        documents: 0,
        taxableAmount: '0.00',
        vatAmount: '0.00',
        exemptAmount: '0.00',
        zeroRatedAmount: '0.00',
        totalAmount: '0.00',
      },
    });
  });
});
