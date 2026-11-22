// The credit position's money rule (D22, F1-Q20, Kuu R4a Q1b): each open item's NPR amount is rounded half-up to
// two decimals before the items are summed, so the exposure is the sum of the amounts a statement would print, and
// the hold compares that sum plus the uninvoiced confirmed orders and the pending order's gross NPR value with the
// limit, strictly. Real: migrations,
// the ledger views and row security, LedgerService. The deal-level pending order (accepted quotations, sales
// orders) is covered with real quotations in sales-orders.integration.test.ts.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { partyAccounts } from '@bos/db';
import { HttpException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { systemActor, withTx } from '../../platform/db/tx';
import { LedgerService } from '../ledger/ledger.service';
import { startHarness, type Harness } from '../leads/test/harness';
import {
  creditPosition,
  orderValueOf,
  overrideCovers,
  type VersionNprSnapshot,
} from './credit-hold';
import { CreditHoldController } from './credit-hold.controller';
import { type CreditHoldService } from './credit-hold.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
const ledger = new LedgerService();

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
});

afterAll(async () => {
  await h?.stop();
});

/** A customer of its own, so no other test's ledger rows count. */
async function customerWithLimit(creditLimit: string): Promise<string> {
  const partyId = await h.seedCustomer();
  await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.insert(partyAccounts).values({ ...h.scopeA, partyId, creditLimit }),
  );
  return partyId;
}

/** An open receivable item, as an issued invoice (debit) or a received payment (credit) leaves it. */
async function openItem(
  partyId: string,
  direction: 'debit' | 'credit',
  currency: 'NPR' | 'USD',
  amount: string,
  fxRate = '1',
): Promise<void> {
  await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    ledger.openItem(tx, h.scopeA, systemActor('test'), {
      side: 'receivable',
      direction,
      partyId,
      sourceType: direction === 'debit' ? 'tax_invoice' : 'payment',
      sourceId: randomUUID(),
      currency,
      amount,
      amountNpr: new Decimal(amount)
        .times(fxRate)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toFixed(2),
      fxRate,
      ...(currency === 'NPR' ? {} : { fxSource: 'nrb', fxDate: '2026-11-20' }),
      documentDate: '2026-11-20',
    }),
  );
}

/** An NPR quotation version of `total` (its NPR snapshot is its total). */
const nprOrder = (total: string): VersionNprSnapshot => ({
  currency: 'NPR',
  total,
  amountNpr: null,
});

const positionOf = (partyId: string, order: VersionNprSnapshot = nprOrder('0.00')) =>
  withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    creditPosition(tx, h.scopeA, partyId, { version: order }),
  );

/** A customer with no limit set at all (no party_accounts row). */
async function customerWithoutLimit(): Promise<string> {
  return h.seedCustomer();
}

describe('the credit exposure rounds each item, then sums (D22)', () => {
  // USD 0.03 at 133.50 is NPR 4.005: each such item counts as 4.01, so two count 8.02, not the 8.01 a sum of the
  // unrounded amounts would give.
  it('is not held exactly at the limit, with mixed currencies', async () => {
    const party = await customerWithLimit('100000.00');
    await openItem(party, 'debit', 'NPR', '99991.98');
    await openItem(party, 'debit', 'USD', '0.03', '133.50');
    await openItem(party, 'debit', 'USD', '0.03', '133.50');
    expect(await positionOf(party)).toEqual({
      creditLimit: '100000.00',
      exposure: '100000.00',
      uninvoiced: '0.00',
      orderValue: '0.00',
      pendingQuotationVersionId: null,
      exposureWithOrder: '100000.00',
      held: false,
    });
  });

  it('is held 0.01 over the limit', async () => {
    const party = await customerWithLimit('100000.00');
    await openItem(party, 'debit', 'NPR', '99991.99');
    await openItem(party, 'debit', 'USD', '0.03', '133.50');
    await openItem(party, 'debit', 'USD', '0.03', '133.50');
    expect(await positionOf(party)).toEqual({
      creditLimit: '100000.00',
      exposure: '100000.01',
      uninvoiced: '0.00',
      orderValue: '0.00',
      pendingQuotationVersionId: null,
      exposureWithOrder: '100000.01',
      held: true,
    });
  });

  it('rounds a foreign-currency credit the same way, so it is not netted below a cent', async () => {
    const party = await customerWithLimit('100000.00');
    await openItem(party, 'debit', 'NPR', '100008.02');
    await openItem(party, 'credit', 'USD', '0.03', '133.50');
    await openItem(party, 'credit', 'USD', '0.03', '133.50');
    expect(await positionOf(party)).toEqual({
      creditLimit: '100000.00',
      exposure: '100000.00',
      uninvoiced: '0.00',
      orderValue: '0.00',
      pendingQuotationVersionId: null,
      exposureWithOrder: '100000.00',
      held: false,
    });
  });
});

describe('the hold counts the order being confirmed on top of the receivables (Kuu R4a Q1b)', () => {
  it('holds a customer at 90,000 of a 100,000 limit for a 20,000 order, not with no order', async () => {
    const party = await customerWithLimit('100000.00');
    await openItem(party, 'debit', 'NPR', '90000.00');
    expect(await positionOf(party)).toMatchObject({ exposure: '90000.00', held: false });
    expect(await positionOf(party, nprOrder('20000.00'))).toEqual({
      creditLimit: '100000.00',
      exposure: '90000.00',
      uninvoiced: '0.00',
      orderValue: '20000.00',
      pendingQuotationVersionId: null,
      exposureWithOrder: '110000.00',
      held: true,
    });
  });

  it('is not held when receivables plus the order are exactly the limit, and is 0.01 over', async () => {
    const party = await customerWithLimit('100000.00');
    await openItem(party, 'debit', 'NPR', '90000.00');
    expect(await positionOf(party, nprOrder('10000.00'))).toMatchObject({
      exposureWithOrder: '100000.00',
      held: false,
    });
    expect(await positionOf(party, nprOrder('10000.01'))).toMatchObject({
      exposureWithOrder: '100000.01',
      held: true,
    });
  });

  it('nets credits and debits before adding the order', async () => {
    // 95,000.00 invoiced + USD 100.00 at 133.50 (13,350.00) less 18,350.00 paid = 90,000.00 owed.
    const party = await customerWithLimit('100000.00');
    await openItem(party, 'debit', 'NPR', '95000.00');
    await openItem(party, 'debit', 'USD', '100.00', '133.50');
    await openItem(party, 'credit', 'NPR', '18350.00');
    expect(await positionOf(party, nprOrder('10000.00'))).toMatchObject({
      exposure: '90000.00',
      exposureWithOrder: '100000.00',
      held: false,
    });
    // A customer in credit has the credit counted against the order.
    const inCredit = await customerWithLimit('100000.00');
    await openItem(inCredit, 'credit', 'NPR', '5000.00');
    expect(await positionOf(inCredit, nprOrder('105000.00'))).toMatchObject({
      exposure: '-5000.00',
      exposureWithOrder: '100000.00',
      held: false,
    });
  });

  it('never holds without a limit, and a 0.00 limit holds any order', async () => {
    const free = await customerWithoutLimit();
    await openItem(free, 'debit', 'NPR', '900000.00');
    expect(await positionOf(free, nprOrder('5000000.00'))).toMatchObject({
      creditLimit: null,
      exposureWithOrder: '5900000.00',
      held: false,
    });
    const none = await customerWithLimit('0.00');
    expect(await positionOf(none)).toMatchObject({ creditLimit: '0.00', held: false });
    expect(await positionOf(none, nprOrder('0.01'))).toMatchObject({
      creditLimit: '0.00',
      orderValue: '0.01',
      held: true,
    });
  });

  it('counts a foreign quotation at its NPR snapshot, gross, rounded half-up to two decimals', () => {
    expect(orderValueOf({ currency: 'USD', total: '150.00', amountNpr: '20025.00' })).toBe(
      '20025.00',
    );
    expect(orderValueOf({ currency: 'NPR', total: '22600.00', amountNpr: null })).toBe('22600.00');
    expect(orderValueOf({ currency: 'NPR', total: '0.005', amountNpr: null })).toBe('0.01');
    expect(orderValueOf({ currency: 'NPR', total: '100.004', amountNpr: null })).toBe('100.00');
    expect(orderValueOf({ currency: 'NPR', total: '100.0050', amountNpr: '100.005' })).toBe(
      '100.01',
    );
    // Without its NPR snapshot a foreign version cannot be valued; never as zero.
    expect(() => orderValueOf({ currency: 'USD', total: '150.00', amountNpr: null })).toThrow(
      /no NPR snapshot/,
    );
  });

  it('names the version being confirmed as the pending one', async () => {
    const party = await customerWithLimit('100000.00');
    const id = randomUUID();
    expect(await positionOf(party, { ...nprOrder('20000.00'), id })).toMatchObject({
      orderValue: '20000.00',
      pendingQuotationVersionId: id,
      held: false,
    });
  });
});

// R5 FU10 (FU4 Q1). Before: an override given for an order of some value covered any later order of the deal at or
// below that value, whatever its quotation version.
describe('an override covers exactly one quotation version and order value', () => {
  const v1 = randomUUID();
  const v2 = randomUUID();

  it('covers the version and value it was given for', () => {
    expect(
      overrideCovers(
        { versionId: v1, orderValue: '22600.00' },
        { versionId: v1, orderValue: '22600.00' },
      ),
    ).toBe(true);
    // Equal as amounts, whatever the scale the column returned.
    expect(
      overrideCovers(
        { versionId: v1, orderValue: '22600.0' },
        { versionId: v1, orderValue: '22600.00' },
      ),
    ).toBe(true);
  });

  it('does not cover a smaller or a bigger order of the same version', () => {
    expect(
      overrideCovers(
        { versionId: v1, orderValue: '22600.00' },
        { versionId: v1, orderValue: '22599.99' },
      ),
    ).toBe(false);
    expect(
      overrideCovers(
        { versionId: v1, orderValue: '22600.00' },
        { versionId: v1, orderValue: '22600.01' },
      ),
    ).toBe(false);
  });

  it('does not cover another version (a second order on the deal, or a new version), even at the same value', () => {
    expect(
      overrideCovers(
        { versionId: v1, orderValue: '22600.00' },
        { versionId: v2, orderValue: '22600.00' },
      ),
    ).toBe(false);
    expect(
      overrideCovers(
        { versionId: v1, orderValue: '22600.00' },
        { versionId: v2, orderValue: '5000.00' },
      ),
    ).toBe(false);
  });

  it('fails closed for an override with no recorded version or value, and when nothing is pending', () => {
    expect(
      overrideCovers(
        { versionId: null, orderValue: '22600.00' },
        { versionId: v1, orderValue: '22600.00' },
      ),
    ).toBe(false);
    expect(
      overrideCovers(
        { versionId: v1, orderValue: null },
        { versionId: v1, orderValue: '22600.00' },
      ),
    ).toBe(false);
    expect(
      overrideCovers(
        { versionId: v1, orderValue: '22600.00' },
        { versionId: null, orderValue: '0.00' },
      ),
    ).toBe(false);
  });
});

// R5 FU10 (FU4 Q3). Before: the order value was optional and there was no quotation version on the body.
describe('the override body needs the quotation version and the order value', () => {
  const service = { override: vi.fn() };
  const controller = new CreditHoldController(service as unknown as CreditHoldService);
  const deal = randomUUID();

  async function statusOf(body: unknown): Promise<number> {
    try {
      await controller.override(deal, body);
    } catch (error) {
      if (error instanceof HttpException) return error.getStatus();
      throw error;
    }
    return 200;
  }

  it('answers 400 without the order value or without the quotation version, and passes a full body on', async () => {
    const quotationVersionId = randomUUID();
    expect(await statusOf({ reason: 'Advance received' })).toBe(400);
    expect(await statusOf({ reason: 'Advance received', quotationVersionId })).toBe(400);
    expect(await statusOf({ reason: 'Advance received', orderValue: '22600.00' })).toBe(400);
    expect(
      await statusOf({
        reason: 'Advance received',
        quotationVersionId: 'v1',
        orderValue: '22600.00',
      }),
    ).toBe(400);
    expect(service.override).not.toHaveBeenCalled();
    const body = { reason: 'Advance received', quotationVersionId, orderValue: '22600.00' };
    expect(await statusOf(body)).toBe(200);
    expect(service.override).toHaveBeenCalledWith(deal, body);
  });
});
