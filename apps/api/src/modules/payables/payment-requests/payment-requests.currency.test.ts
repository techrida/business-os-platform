// Unit tests for the currency of PaymentRequestsService.create, with a fake database (no Docker). Payment requests
// are exempt from the D44 switch-off (D56 U16-Q1), as payments are: a switched-off currency is accepted and the
// setting is never read, while an unknown currency is still refused by the contract.
// Run with: pnpm --filter @bos/api exec vitest run src/modules/payables/payment-requests/payment-requests.currency.test.ts
//
// The real create runs through the real withTx and withIdempotency. The fake answers only what those ask: the
// transaction's set_config, the idempotency claim, a `currency.enabled` read (counted, so a test can show none
// happens; a saved row when the test gives one), the company bank account select with the rows the test gives
// (round 5, P1) and every other select with no rows. With an active bank account in the request's currency and no
// vendor rows, a create that gets past the bank check stops at 404 Vendor.
import { RequestPaymentBodySchema } from '@bos/contracts';
import { companyBankAccounts } from '@bos/db';
import { HttpException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import type { ApprovalsService } from '../../approvals/requests.service';
import type { AuditService } from '../../../platform/audit/audit.service';
import type { VendorBankService } from '../../vendors/bank/bank.service';
import type { PaymentRequestsCaller } from './payment-requests.caller';
import { PaymentRequestsService } from './payment-requests.service';

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '10000000-0000-4000-8000-000000000001',
};
const userId = '20000000-0000-4000-8000-000000000001';
const dialect = new PgDialect();

/**
 * A Db for one create: `saved` is the stored `currency.enabled` (null: nothing saved) and `bank` what the company
 * bank account select finds. Counts reads and selects.
 */
function fakeDb(saved: unknown[] | null, bank: { status: string; currency: string }[] = []) {
  const settingsReads: unknown[][] = [];
  let selects = 0;
  const rowsOf = (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    if (text.includes('FROM app.settings')) {
      settingsReads.push(params);
      return { rows: saved ? [{ version: 2, value: saved }] : [] };
    }
    // withTx's own statements: the settings, then the tenant audit lock.
    if (text.includes('set_config(') || text.includes('pg_advisory_xact_lock('))
      return { rows: [] };
    if (text.includes("current_setting('bos.tenant_id'")) {
      return {
        rows: [
          { tenant_id: scope.tenantId, organization_id: scope.organizationId, actor_id: userId },
        ],
      };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  // A select from company_bank_accounts resolves to `bank`, any other to no rows, whatever it chains.
  const chainOf = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const step of ['where', 'innerJoin', 'orderBy', 'for']) chain[step] = () => chain;
    chain.then = (resolve: (found: unknown[]) => unknown) => resolve(rows);
    return chain;
  };
  const tx = {
    execute: (query: Parameters<typeof dialect.sqlToQuery>[0]) => Promise.resolve(rowsOf(query)),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 'claim-1' }]) }),
      }),
    }),
    select: () => {
      selects += 1;
      return { from: (table: unknown) => chainOf(table === companyBankAccounts ? bank : []) };
    },
  };
  const db = {
    execute: (query: Parameters<typeof dialect.sqlToQuery>[0]) => Promise.resolve(rowsOf(query)),
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
  return { db, settingsReads, selectCount: () => selects };
}

const caller = {
  current: () => ({
    scope,
    actor: { kind: 'user', id: userId, correlationId: 'corr-payment-request-currency' },
    principal: { userId } as Principal,
  }),
} as unknown as PaymentRequestsCaller;

/** The service as the integration tests build it; the bank account check is the default one. */
function serviceOn(db: Db): PaymentRequestsService {
  return new PaymentRequestsService(
    db,
    {} as ApprovalsService,
    {} as AuditService,
    {} as VendorBankService,
    caller,
    () => new Date('2026-11-19T10:00:00Z'),
  );
}

/** A request body as the API receives it, parsed through the contract. */
const bodyIn = (currency: string) =>
  RequestPaymentBodySchema.parse({
    vendorPartyId: '30000000-0000-4000-8000-000000000001',
    paymentType: 'settlement',
    currency,
    fromBankAccountId: '40000000-0000-4000-8000-000000000001',
    allocations: [{ openItemId: '50000000-0000-4000-8000-000000000001', amount: '100.00' }],
  });

/** Runs `fn` and returns what it threw. */
async function caught(fn: () => Promise<unknown>): Promise<HttpException> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected a throw');
}

describe('PaymentRequestsService.create: currency (exempt from D44, D56 U16-Q1)', () => {
  it('accepts a currency the company switched off without reading the setting, and goes on to the bank and vendor checks', async () => {
    const { db, settingsReads, selectCount } = fakeDb(
      ['NPR', 'USD'],
      [{ status: 'active', currency: 'INR' }],
    );
    // Old code: 422 CURRENCY_NOT_ENABLED before the bank account was read.
    const error = await caught(() => serviceOn(db).create(bodyIn('INR'), 'key-switched-off'));
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({ code: 'not_found', message: 'Vendor not found' });
    expect(settingsReads).toEqual([]);
    expect(selectCount()).toBe(2);
  });

  it('accepts a currency missing from a saved list that holds only NPR', async () => {
    const { db, settingsReads } = fakeDb(['NPR'], [{ status: 'active', currency: 'USD' }]);
    const error = await caught(() => serviceOn(db).create(bodyIn('USD'), 'key-npr-only'));
    expect(error.getResponse()).toEqual({ code: 'not_found', message: 'Vendor not found' });
    expect(settingsReads).toEqual([]);
  });

  it('still refuses a currency that is not a known one at the contract the controller parses with', () => {
    const parsed = RequestPaymentBodySchema.safeParse({
      vendorPartyId: '30000000-0000-4000-8000-000000000001',
      paymentType: 'settlement',
      currency: 'EUR',
      fromBankAccountId: '40000000-0000-4000-8000-000000000001',
      allocations: [{ openItemId: '50000000-0000-4000-8000-000000000001', amount: '100.00' }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['currency']]);
  });

  it('checks the paying bank account before the vendor (round 5, P1)', async () => {
    const missing = fakeDb(['NPR']);
    const invalid = await caught(() => serviceOn(missing.db).create(bodyIn('NPR'), 'key-bank'));
    expect(invalid.getStatus()).toBe(422);
    expect(invalid.getResponse()).toMatchObject({ code: 'BANK_ACCOUNT_INVALID' });
    expect(missing.selectCount()).toBe(1);

    const usd = fakeDb(['NPR'], [{ status: 'active', currency: 'USD' }]);
    const mismatch = await caught(() => serviceOn(usd.db).create(bodyIn('NPR'), 'key-usd'));
    expect(mismatch.getStatus()).toBe(422);
    expect(mismatch.getResponse()).toMatchObject({ code: 'BANK_ACCOUNT_CURRENCY_MISMATCH' });
    expect(usd.selectCount()).toBe(1);
  });
});
