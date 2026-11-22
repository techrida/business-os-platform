// The credit position's orders part (R5 FU10). A credit note frees the part of the order its invoice no longer bills:
// the note offsets the invoice in the receivables and the freed part counts once as uninvoiced, so a 100.00 order
// invoiced in full with 40.00 credited is 60.00 owed plus 40.00 uninvoiced. And the deal's pending order is read in
// the same statement as the receivables and the orders, with the version it comes from. Real: migrations, the
// invoice and quotation guards, row security, LedgerService. Rows are written the way the guards let them.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { opportunities, partyAccounts } from '@bos/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../platform/db/tx';
import { systemActor, withTx } from '../../platform/db/tx';
import { LedgerService } from '../ledger/ledger.service';
import { startHarness, type Harness } from '../leads/test/harness';
import { creditPosition, type PendingOrder } from './credit-hold';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
const ledger = new LedgerService();
let seq = 0;

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
});

afterAll(async () => {
  await h?.stop();
});

const asSystem = <T>(work: (tx: DbTransaction) => Promise<T>) =>
  withTx(h.db, h.scopeA, systemActor('test'), work);

/** A customer of its own with a limit, so no other test's rows count. */
async function customer(): Promise<string> {
  const partyId = await h.seedCustomer();
  await asSystem((tx) =>
    tx.insert(partyAccounts).values({ ...h.scopeA, partyId, creditLimit: '1000000.00' }),
  );
  return partyId;
}

async function deal(partyId: string): Promise<string> {
  const [row] = await asSystem((tx) =>
    tx
      .insert(opportunities)
      .values({
        ...h.scopeA,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: 'Acme website',
        customerId: partyId,
        ownerUserId: h.users.salesA,
      })
      .returning({ id: opportunities.id }),
  );
  return row!.id;
}

/** A quotation of the deal with one version accepted at `total` (NPR, no VAT); its quotation and version ids. */
async function acceptedVersion(
  partyId: string,
  opportunityId: string,
  total: string,
): Promise<{ quotationId: string; versionId: string }> {
  return asSystem(async (tx) => {
    const one = async (q: ReturnType<typeof sql>) =>
      (await tx.execute<{ id: string }>(q)).rows[0]!.id;
    const quotationId = await one(
      sql`INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
          VALUES (${h.scopeA.tenantId}, ${h.scopeA.organizationId}, ${`QT-${randomUUID().slice(0, 8)}`},
                  ${partyId}, ${opportunityId}) RETURNING id`,
    );
    const versionId = await one(
      sql`INSERT INTO app.quotation_versions (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
          VALUES (${h.scopeA.tenantId}, ${h.scopeA.organizationId}, ${quotationId}, 1, 'NPR', '2026-11-09', '2026-12-09')
          RETURNING id`,
    );
    await tx.execute(sql`
      UPDATE app.quotation_versions
         SET status = 'accepted', subtotal = ${total}, taxable_amount = ${total}, tax_amount = 0, total = ${total},
             fx_rate = 1, amount_npr = ${total}, npr_taxable_amount = ${total},
             content_sha256 = sha256('content'::bytea), snapshot_sha256 = sha256('snapshot'::bytea)
       WHERE id = ${versionId}`);
    return { quotationId, versionId };
  });
}

/**
 * A confirmed order of `total` in `currency` at `fxRate` NPR per unit (no VAT), on a quotation of a deal of its
 * own unless `on` names one; its id.
 */
async function confirmedOrder(
  partyId: string,
  total: string,
  currency: 'NPR' | 'USD' = 'NPR',
  fxRate = '1',
  on?: { quotationId: string; versionId: string },
): Promise<string> {
  const quotation = on ?? (await acceptedVersion(partyId, await deal(partyId), total));
  seq += 1;
  const amountNpr = (Number(total) * Number(fxRate)).toFixed(2);
  const fx =
    currency === 'NPR' ? sql`NULL, NULL` : sql`'nrb', '2026-11-19'::date`;
  return asSystem(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.sales_orders (tenant_id, organization_id, number, seq, fiscal_year, customer_party_id,
            quotation_id, quotation_version_id, status, currency, subtotal, discount_amount, taxable_amount, tax_amount,
            total, fx_rate, fx_source, fx_date, amount_npr, credit_days, confirmed_at)
          VALUES (${h.scopeA.tenantId}, ${h.scopeA.organizationId}, ${`SO-2083/84-${String(seq).padStart(5, '0')}`},
            ${seq}, '2083/84', ${partyId}, ${quotation.quotationId}, ${quotation.versionId}, 'confirmed', ${currency},
            ${total}, 0, ${total}, 0, ${total}, ${fxRate}, ${fx}, ${amountNpr}, 30, now())
          RETURNING id`);
    return rows[0]!.id;
  });
}

/**
 * An invoice of the order taken through draft and approved to `status` the way the guard (invoices_guard) lets it:
 * a tax invoice, or a credit note on `original`. An issued one leaves its open receivable item (a debit, or a credit
 * for a note) at `fxRate`.
 */
async function invoice(
  partyId: string,
  orderId: string,
  total: string,
  options: {
    currency?: 'NPR' | 'USD';
    fxRate?: string;
    original?: string;
    status?: 'approved' | 'issued';
  } = {},
): Promise<string> {
  const { currency = 'NPR', fxRate = '1', original, status = 'issued' } = options;
  const id = randomUUID();
  const kind = original === undefined ? 'tax_invoice' : 'credit_note';
  const amountNpr = (Number(total) * Number(fxRate)).toFixed(2);
  seq += 1;
  await asSystem(async (tx) => {
    await tx.execute(sql`
      INSERT INTO app.invoices (id, tenant_id, organization_id, kind, status, customer_party_id, sales_order_id,
                                original_invoice_id, note_reason, currency, subtotal, taxable_vat_amount, tax_amount,
                                total)
      VALUES (${id}, ${h.scopeA.tenantId}, ${h.scopeA.organizationId}, ${kind}, 'draft', ${partyId}, ${orderId},
              ${original ?? null}, ${original === undefined ? null : 'Not delivered'}, ${currency}, ${total},
              ${total}, 0, ${total})`);
    await tx.execute(
      sql`UPDATE app.invoices SET status = 'approved', version = version + 1 WHERE id = ${id}`,
    );
    if (status === 'approved') return;
    await tx.execute(sql`
      UPDATE app.invoices
         SET status = 'issued', number = ${`INV-${id.slice(0, 8)}`}, seq = ${seq}, fiscal_year = '2083/84',
             issue_date = '2026-11-20', issue_date_bs = '2083-08-05', due_date = '2026-12-20', fx_rate = ${fxRate},
             fx_source = ${currency === 'NPR' ? null : 'nrb'}, fx_date = ${currency === 'NPR' ? null : '2026-11-20'},
             amount_npr = ${amountNpr}, seller_snapshot = '{}'::jsonb, buyer_snapshot = '{}'::jsonb,
             content_hash = sha256('invoice'::bytea), issued_at = now(), version = version + 1
       WHERE id = ${id}`);
  });
  if (status === 'issued') {
    await asSystem((tx) =>
      ledger.openItem(tx, h.scopeA, systemActor('test'), {
        side: 'receivable',
        direction: original === undefined ? 'debit' : 'credit',
        partyId,
        sourceType: kind,
        sourceId: id,
        currency,
        amount: total,
        amountNpr,
        fxRate,
        ...(currency === 'NPR' ? {} : { fxSource: 'nrb', fxDate: '2026-11-20' }),
        documentDate: '2026-11-20',
      }),
    );
  }
  return id;
}

const NO_ORDER: PendingOrder = { version: { currency: 'NPR', total: '0.00', amountNpr: null } };

const positionOf = (partyId: string, pending: PendingOrder = NO_ORDER) =>
  asSystem((tx) => creditPosition(tx, h.scopeA, partyId, pending));

describe('a credit note frees the part of the order its invoice no longer bills', () => {
  it('counts the credited part of an NPR invoice as uninvoiced again, once', async () => {
    const party = await customer();
    const order = await confirmedOrder(party, '100.00');
    const inv = await invoice(party, order, '100.00');
    expect(await positionOf(party)).toMatchObject({ exposure: '100.00', uninvoiced: '0.00' });
    await invoice(party, order, '40.00', { original: inv });
    // 60.00 owed plus 40.00 to invoice: the order's 100.00, as with no credit at all.
    expect(await positionOf(party)).toMatchObject({
      exposure: '60.00',
      uninvoiced: '40.00',
      exposureWithOrder: '100.00',
    });
    // Two notes on one invoice add up.
    await invoice(party, order, '10.00', { original: inv });
    expect(await positionOf(party)).toMatchObject({ exposure: '50.00', uninvoiced: '50.00' });
  });

  it("works out a foreign order's freed part in its currency and converts it at the order's rate", async () => {
    // Ordered at 130.005 NPR per USD, invoiced in full at 128: USD 1.00 credited frees 130.005, half-up 130.01.
    const party = await customer();
    const order = await confirmedOrder(party, '1000.00', 'USD', '130.005');
    const inv = await invoice(party, order, '1000.00', { currency: 'USD', fxRate: '128' });
    expect(await positionOf(party)).toMatchObject({ exposure: '128000.00', uninvoiced: '0.00' });
    await invoice(party, order, '1.00', { currency: 'USD', fxRate: '128', original: inv });
    expect(await positionOf(party)).toMatchObject({ exposure: '127872.00', uninvoiced: '130.01' });
  });

  it('still counts an invoice credited in full as not billed, and never frees more than the order', async () => {
    const party = await customer();
    const order = await confirmedOrder(party, '100.00');
    const inv = await invoice(party, order, '100.00');
    await invoice(party, order, '100.00', { original: inv });
    expect(await positionOf(party)).toMatchObject({ exposure: '0.00', uninvoiced: '100.00' });
    await asSystem((tx) =>
      tx.execute(sql`UPDATE app.invoices SET credited_in_full_at = now() WHERE id = ${inv}`),
    );
    expect(await positionOf(party)).toMatchObject({ exposure: '0.00', uninvoiced: '100.00' });
  });

  it('frees nothing for a credit note not yet issued', async () => {
    const party = await customer();
    const order = await confirmedOrder(party, '100.00');
    const inv = await invoice(party, order, '100.00');
    await invoice(party, order, '40.00', { original: inv, status: 'approved' });
    expect(await positionOf(party)).toMatchObject({ exposure: '100.00', uninvoiced: '0.00' });
  });
});

describe("the deal's pending order is read with the receivables and the orders", () => {
  it('reads the position of a deal in one statement', async () => {
    const party = await customer();
    const opportunityId = await deal(party);
    await acceptedVersion(party, opportunityId, '500.00');
    await invoice(party, await confirmedOrder(party, '300.00'), '100.00');
    let statements = 0;
    const position = await asSystem((tx) => {
      const counted = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== 'execute') return Reflect.get(target, prop, receiver) as unknown;
          return (...args: Parameters<typeof tx.execute>) => {
            statements += 1;
            return target.execute(...args);
          };
        },
      });
      return creditPosition(counted, h.scopeA, party, { opportunityId });
    });
    expect(statements).toBe(1);
    expect(position).toMatchObject({
      exposure: '100.00',
      uninvoiced: '200.00',
      orderValue: '500.00',
      exposureWithOrder: '800.00',
    });
  });

  it('names the largest pending version, the lowest id of equal ones, and none once ordered', async () => {
    const party = await customer();
    const opportunityId = await deal(party);
    expect(await positionOf(party, { opportunityId })).toMatchObject({
      orderValue: '0.00',
      pendingQuotationVersionId: null,
    });
    await acceptedVersion(party, opportunityId, '100.00');
    const tied = [
      await acceptedVersion(party, opportunityId, '500.00'),
      await acceptedVersion(party, opportunityId, '500.00'),
    ];
    const lowest = tied.map((t) => t.versionId).sort()[0]!;
    expect(await positionOf(party, { opportunityId })).toMatchObject({
      orderValue: '500.00',
      pendingQuotationVersionId: lowest,
    });
    // A quotation with a confirmed order is no longer pending: the other 500.00 counts.
    const ordered = tied.find((t) => t.versionId === lowest)!;
    await confirmedOrder(party, '500.00', 'NPR', '1', ordered);
    const other = tied.find((t) => t.versionId !== lowest)!.versionId;
    expect(await positionOf(party, { opportunityId })).toMatchObject({
      uninvoiced: '500.00',
      orderValue: '500.00',
      pendingQuotationVersionId: other,
    });
  });

  it('names the version being confirmed at the gate when the caller passes its id', async () => {
    const party = await customer();
    const id = randomUUID();
    expect(
      await positionOf(party, { version: { id, currency: 'NPR', total: '10.00', amountNpr: null } }),
    ).toMatchObject({ orderValue: '10.00', pendingQuotationVersionId: id });
    expect(await positionOf(party)).toMatchObject({ pendingQuotationVersionId: null });
  });
});
