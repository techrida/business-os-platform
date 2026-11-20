// The credit position's money rule (D22, F1-Q20): each open item's NPR amount is rounded half-up to two decimals
// before the items are summed, so the exposure is the sum of the amounts a statement would print, and the hold
// compares that sum with the limit. Real: migrations, the ledger views and row security, LedgerService.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { partyAccounts } from '@bos/db';
import Decimal from 'decimal.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { systemActor, withTx } from '../../platform/db/tx';
import { LedgerService } from '../ledger/ledger.service';
import { startHarness, type Harness } from '../leads/test/harness';
import { creditPosition } from './credit-hold';

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

const positionOf = (partyId: string) =>
  withTx(h.db, h.scopeA, systemActor('test'), (tx) => creditPosition(tx, h.scopeA, partyId));

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
      held: false,
    });
  });
});
