// Integration test of LedgerService on a real postgres:16-alpine (Testcontainers, needs Docker in WSL).
// Run with: pnpm --filter @bos/api exec vitest run src/modules/ledger/ledger.integration.test.ts
//
// Real: migrations through 0019_open_items as bos_owner, every query as bos_app (append-only privileges, the
// match and cap triggers, the open_item_balances view), withTx with a system actor. Replays, the parallel
// allocation race and the lock order only show up against a real database.
import { randomUUID } from 'node:crypto';

import { createParty, createTenantWithEntity, postingEvents } from '@bos/db';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Db } from '../../platform/db/db.module';
import { type TxScope, systemActor, withTx } from '../../platform/db/tx';
import { LedgerError, LedgerService, type OpenItemInput } from './ledger.service';
import { LockOrderError } from './lock-order';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
const ledger = new LedgerService();
const actor = systemActor('ledger-test');

interface World {
  scope: TxScope;
  customer: string;
  otherCustomer: string;
  vendor: string;
}

/** Each test uses its own tenant, so no test sees another's rows. */
async function newWorld(): Promise<World> {
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  const customer = await createParty(appPool, { tenantId, organizationId, kind: 'customer' });
  const otherCustomer = await createParty(appPool, { tenantId, organizationId, kind: 'customer' });
  const vendor = await createParty(appPool, { tenantId, organizationId, kind: 'vendor' });
  return {
    scope: { tenantId, organizationId },
    customer: customer.partyId,
    otherCustomer: otherCustomer.partyId,
    vendor: vendor.partyId,
  };
}

/** An NPR receivable item: a tax invoice (debit) or a payment (credit). */
function receivable(
  partyId: string,
  direction: 'debit' | 'credit',
  amount: string,
  over: Partial<OpenItemInput> = {},
): OpenItemInput {
  return {
    side: 'receivable',
    direction,
    partyId,
    sourceType: direction === 'debit' ? 'tax_invoice' : 'payment',
    sourceId: randomUUID(),
    currency: 'NPR',
    amount,
    amountNpr: amount,
    fxRate: '1',
    documentDate: '2026-11-09',
    ...over,
  };
}

function inTx<T>(w: World, fn: Parameters<typeof withTx<T>>[3]): Promise<T> {
  return withTx(db, w.scope, actor, fn);
}

async function open(w: World, input: OpenItemInput): Promise<string> {
  const { item } = await inTx(w, (tx) => ledger.openItem(tx, w.scope, actor, input));
  return item.id;
}

async function openAmount(w: World, id: string): Promise<string | undefined> {
  const amounts = await inTx(w, (tx) => ledger.openAmounts(tx, w.scope, [id]));
  return amounts.get(id);
}

/** The LedgerError code a promise rejects with, or 'resolved'. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof LedgerError ? error.code : `not a LedgerError: ${String(error)}`;
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  // Twelve connections: the race below holds ten transactions open at once.
  appPool = new Pool({ connectionString: testDb.appUrl, max: 12 });
  appPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('openItem', () => {
  it('replays per source: same id, created false, even with 100 vs 100.00', async () => {
    const w = await newWorld();
    const input = receivable(w.customer, 'debit', '100');
    const first = await inTx(w, (tx) => ledger.openItem(tx, w.scope, actor, input));
    const replay = await inTx(w, (tx) =>
      ledger.openItem(tx, w.scope, actor, { ...input, amount: '100.00' }),
    );
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.item.id).toBe(first.item.id);
    expect(first.item.createdBy).toBeNull();
    expect(await openAmount(w, first.item.id)).toBe('100.00');
  });

  it('refuses a replay with a different amount or party (OPEN_ITEM_CONFLICT)', async () => {
    const w = await newWorld();
    const input = receivable(w.customer, 'debit', '100.00');
    await open(w, input);
    expect(
      await codeOf(
        inTx(w, (tx) =>
          ledger.openItem(tx, w.scope, actor, { ...input, amount: '99.99', amountNpr: '99.99' }),
        ),
      ),
    ).toBe('OPEN_ITEM_CONFLICT');
    expect(
      await codeOf(
        inTx(w, (tx) =>
          ledger.openItem(tx, w.scope, actor, { ...input, partyId: w.otherCustomer }),
        ),
      ),
    ).toBe('OPEN_ITEM_CONFLICT');
  });

  it('puts a payable item on the vendor column', async () => {
    const w = await newWorld();
    const { item } = await inTx(w, (tx) =>
      ledger.openItem(tx, w.scope, actor, {
        ...receivable(w.vendor, 'credit', '50.00'),
        side: 'payable',
        sourceType: 'vendor_bill',
      }),
    );
    expect(item.vendorPartyId).toBe(w.vendor);
    expect(item.customerPartyId).toBeNull();
  });
});

describe('recordEvent', () => {
  it('replays per (source, event): same row, original payload kept', async () => {
    const w = await newWorld();
    const sourceId = randomUUID();
    const first = await inTx(w, (tx) =>
      ledger.recordEvent(tx, w.scope, actor, {
        sourceType: 'tax_invoice',
        sourceId,
        event: 'invoice_issued',
        payload: { total: '100.00' },
      }),
    );
    const replay = await inTx(w, (tx) =>
      ledger.recordEvent(tx, w.scope, actor, {
        sourceType: 'tax_invoice',
        sourceId,
        event: 'invoice_issued',
        payload: { total: '999.00' },
      }),
    );
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(first.event.id);
    expect(replay.event.payload).toEqual({ total: '100.00' });
  });
});

describe('allocate and reverseAllocation', () => {
  it('allocates, records the event, and a reversal restores the open amounts once', async () => {
    const w = await newWorld();
    const debit = await open(w, receivable(w.customer, 'debit', '100.00'));
    const credit = await open(w, receivable(w.customer, 'credit', '40.00'));

    const allocation = await inTx(w, (tx) =>
      ledger.allocate(tx, w.scope, actor, {
        debitItemId: debit,
        creditItemId: credit,
        amount: '40',
      }),
    );
    expect(allocation.amount).toBe('40.00');
    expect(await openAmount(w, debit)).toBe('60.00');
    expect(await openAmount(w, credit)).toBe('0.00');

    const reversal = await inTx(w, (tx) =>
      ledger.reverseAllocation(tx, w.scope, actor, {
        allocationId: allocation.id,
        reason: 'wrong invoice',
      }),
    );
    expect(reversal.created).toBe(true);
    expect(reversal.allocation.amount).toBe('-40.00');
    expect(reversal.allocation.reversesAllocationId).toBe(allocation.id);
    expect(await openAmount(w, debit)).toBe('100.00');
    expect(await openAmount(w, credit)).toBe('40.00');

    const replay = await inTx(w, (tx) =>
      ledger.reverseAllocation(tx, w.scope, actor, {
        allocationId: allocation.id,
        reason: 'again',
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.allocation.id).toBe(reversal.allocation.id);
    expect(await openAmount(w, debit)).toBe('100.00');

    const events = await db
      .select({ event: postingEvents.event, sourceId: postingEvents.sourceId })
      .from(postingEvents)
      .where(
        and(
          eq(postingEvents.tenantId, w.scope.tenantId),
          eq(postingEvents.sourceType, 'allocation'),
        ),
      );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        { event: 'allocation', sourceId: allocation.id },
        { event: 'allocation_reversed', sourceId: reversal.allocation.id },
      ]),
    );
  });

  it('refuses a reversal without a reason and the reversal of a reversal', async () => {
    const w = await newWorld();
    const debit = await open(w, receivable(w.customer, 'debit', '10.00'));
    const credit = await open(w, receivable(w.customer, 'credit', '10.00'));
    const allocation = await inTx(w, (tx) =>
      ledger.allocate(tx, w.scope, actor, {
        debitItemId: debit,
        creditItemId: credit,
        amount: '10',
      }),
    );
    expect(
      await codeOf(
        inTx(w, (tx) =>
          ledger.reverseAllocation(tx, w.scope, actor, {
            allocationId: allocation.id,
            reason: ' ',
          }),
        ),
      ),
    ).toBe('REASON_REQUIRED');
    const { allocation: reversal } = await inTx(w, (tx) =>
      ledger.reverseAllocation(tx, w.scope, actor, { allocationId: allocation.id, reason: 'oops' }),
    );
    expect(
      await codeOf(
        inTx(w, (tx) =>
          ledger.reverseAllocation(tx, w.scope, actor, {
            allocationId: reversal.id,
            reason: 'undo',
          }),
        ),
      ),
    ).toBe('ALLOCATION_NOT_REVERSIBLE');
  });

  it('refuses more than the open amount (OVER_ALLOCATION) and a bad amount', async () => {
    const w = await newWorld();
    const debit = await open(w, receivable(w.customer, 'debit', '100.00'));
    const credit = await open(w, receivable(w.customer, 'credit', '150.00'));
    const allocate = (amount: string) =>
      inTx(w, (tx) =>
        ledger.allocate(tx, w.scope, actor, { debitItemId: debit, creditItemId: credit, amount }),
      );
    expect(await codeOf(allocate('100.01'))).toBe('OVER_ALLOCATION');
    expect(await codeOf(allocate('0'))).toBe('INVALID_AMOUNT');
    expect(await codeOf(allocate('1.001'))).toBe('INVALID_AMOUNT');
    expect(await codeOf(allocate('100.00'))).toBe('resolved');
    expect(await codeOf(allocate('0.01'))).toBe('OVER_ALLOCATION');
  });

  it('refuses mismatched side, party, currency and direction (MISMATCHED_ITEMS)', async () => {
    const w = await newWorld();
    const debit = await open(w, receivable(w.customer, 'debit', '100.00'));
    const otherParty = await open(w, receivable(w.otherCustomer, 'credit', '10.00'));
    const usd = await open(
      w,
      receivable(w.customer, 'credit', '10.00', {
        currency: 'USD',
        amountNpr: '1335.00',
        fxRate: '133.5',
        fxSource: 'NRB',
        fxDate: '2026-11-09',
      }),
    );
    const payable = await open(w, {
      ...receivable(w.vendor, 'credit', '10.00'),
      side: 'payable',
      sourceType: 'vendor_bill',
    });
    const secondDebit = await open(w, receivable(w.customer, 'debit', '10.00'));
    for (const creditItemId of [otherParty, usd, payable, secondDebit]) {
      expect(
        await codeOf(
          inTx(w, (tx) =>
            ledger.allocate(tx, w.scope, actor, { debitItemId: debit, creditItemId, amount: '1' }),
          ),
        ),
      ).toBe('MISMATCHED_ITEMS');
    }
    expect(await openAmount(w, debit)).toBe('100.00');
  });

  it('runs 10 parallel allocations of 30% against one item: 3 win, 7 get OVER_ALLOCATION, never over', async () => {
    const w = await newWorld();
    const debit = await open(w, receivable(w.customer, 'debit', '100.00'));
    const credits: string[] = [];
    for (let i = 0; i < 10; i += 1)
      credits.push(await open(w, receivable(w.customer, 'credit', '30.00')));

    const results = await Promise.all(
      credits.map((creditItemId) =>
        codeOf(
          inTx(w, (tx) =>
            ledger.allocate(tx, w.scope, actor, {
              debitItemId: debit,
              creditItemId,
              amount: '30.00',
            }),
          ),
        ),
      ),
    );
    expect(results.filter((code) => code === 'resolved')).toHaveLength(3);
    expect(results.filter((code) => code === 'OVER_ALLOCATION')).toHaveLength(7);
    expect(await openAmount(w, debit)).toBe('10.00');
  });
});

describe('openAmounts and lockForMoneyCommand', () => {
  it('leaves an unknown id out instead of reporting 0', async () => {
    const w = await newWorld();
    const debit = await open(w, receivable(w.customer, 'debit', '5.00'));
    const unknown = randomUUID();
    const amounts = await inTx(w, (tx) => ledger.openAmounts(tx, w.scope, [debit, unknown]));
    expect([...amounts]).toEqual([[debit, '5.00']]);
  });

  it('locks open items in ascending id order, reports what exists, and refuses a step out of order', async () => {
    const w = await newWorld();
    const a = await open(w, receivable(w.customer, 'debit', '5.00'));
    const b = await open(w, receivable(w.customer, 'credit', '5.00'));
    const unknown = randomUUID();
    const locked = await inTx(w, (tx) =>
      ledger.lockForMoneyCommand(tx, w.scope, [{ rank: 'open_item', ids: [b, unknown, a] }]),
    );
    expect(locked.open_item).toEqual([a, b].sort());
    await expect(
      inTx(w, (tx) =>
        ledger.lockForMoneyCommand(tx, w.scope, [
          { rank: 'open_item', ids: [a] },
          { rank: 'invoice', ids: [b], table: postingEvents },
        ]),
      ),
    ).rejects.toBeInstanceOf(LockOrderError);
  });
});
