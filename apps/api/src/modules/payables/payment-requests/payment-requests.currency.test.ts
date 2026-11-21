// Unit tests for the D44 currency check in PaymentRequestsService.create, with a fake database (no Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/modules/payables/payment-requests/payment-requests.currency.test.ts
//
// The real create runs through the real withTx, withIdempotency, CurrencyEnabledService and SettingsService. The fake
// answers only what those ask: the transaction's set_config, the idempotency claim, the `currency.enabled` read (a
// saved row when the test gives one, otherwise none, so the default list is the contract's SETTING_DEFAULTS), the
// company bank account select with the rows the test gives (round 5, P1) and every other select with no rows. With
// an active bank account in the request's currency and no vendor rows, a create that gets past both checks stops at
// 404 Vendor.
import { RequestPaymentBodySchema } from '@bos/contracts';
import { companyBankAccounts } from '@bos/db';
import { HttpException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import { SettingsService } from '../../../platform/settings/settings.service';
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
    if (text.includes('set_config(')) return { rows: [] };
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

/** The service as Nest wires it (SettingsModule provides the check), or as the integration tests build it. */
function serviceOn(db: Db, injected = true): PaymentRequestsService {
  const deps = [
    db,
    {} as ApprovalsService,
    {} as AuditService,
    {} as VendorBankService,
    caller,
    () => new Date('2026-11-19T10:00:00Z'),
  ] as const;
  return injected
    ? new PaymentRequestsService(
        ...deps,
        undefined,
        new CurrencyEnabledService(new SettingsService(db)),
      )
    : new PaymentRequestsService(...deps);
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

describe('PaymentRequestsService.create: enabled currency (D44)', () => {
  it('refuses a currency the company switched off with 422 CURRENCY_NOT_ENABLED before reading the vendor', async () => {
    const { db, settingsReads, selectCount } = fakeDb(['NPR', 'USD']);
    const error = await caught(() => serviceOn(db).create(bodyIn('INR'), 'key-refused'));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency INR is not enabled for this company',
      details: { currency: 'INR' },
    });
    expect(settingsReads).toEqual([[scope.tenantId, scope.organizationId, 'currency.enabled']]);
    expect(selectCount()).toBe(0);
  });

  it('accepts a currency in the default list when nothing is saved and goes on to the bank and vendor checks', async () => {
    const { db, settingsReads, selectCount } = fakeDb(null, [
      { status: 'active', currency: 'INR' },
    ]);
    const error = await caught(() => serviceOn(db).create(bodyIn('INR'), 'key-default'));
    expect(settingsReads).toHaveLength(1);
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({ code: 'not_found', message: 'Vendor not found' });
    expect(selectCount()).toBe(2);
  });

  it('checks the paying bank account after the currency and before the vendor (round 5, P1)', async () => {
    const missing = fakeDb(['NPR']);
    const invalid = await caught(() => serviceOn(missing.db).create(bodyIn('NPR'), 'key-bank'));
    expect(invalid.getStatus()).toBe(422);
    expect(invalid.getResponse()).toMatchObject({ code: 'BANK_ACCOUNT_INVALID' });
    expect(missing.selectCount()).toBe(1);

    const usd = fakeDb(['NPR'], [{ status: 'active', currency: 'USD' }]);
    const mismatch = await caught(() => serviceOn(usd.db, false).create(bodyIn('NPR'), 'key-usd'));
    expect(mismatch.getStatus()).toBe(422);
    expect(mismatch.getResponse()).toMatchObject({ code: 'BANK_ACCOUNT_CURRENCY_MISMATCH' });
    expect(usd.selectCount()).toBe(1);
  });

  it('still refuses when the service is built without the injected check (the fallback reads the same db)', async () => {
    const { db, selectCount } = fakeDb(['NPR', 'INR']);
    const error = await caught(() => serviceOn(db, false).create(bodyIn('USD'), 'key-fallback'));
    expect(error.getResponse()).toMatchObject({ code: 'CURRENCY_NOT_ENABLED' });
    expect(selectCount()).toBe(0);
  });
});
