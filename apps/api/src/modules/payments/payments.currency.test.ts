// Unit tests: a payment in a currency the company switched off is refused before anything is written (D44), on the
// staff and the portal channel alike, and only after the permission check. No Docker: the database is a fake whose
// transaction only records that it was opened.
// Run with: pnpm --filter @bos/api exec vitest run src/modules/payments/payments.currency.test.ts
import type { SubmitPaymentBody } from '@bos/contracts';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Db } from '../../platform/db/db.module';
import type { Actor, TxScope } from '../../platform/db/tx';
import {
  currencyNotEnabled,
  CurrencyEnabledService,
} from '../../platform/settings/currency-enabled';
import type { MoneyService } from '../../platform/settings/money.service';
import type { NumberingService } from '../../platform/settings/numbering.service';
import type { SettingsService } from '../../platform/settings/settings.service';
import type { LedgerService } from '../ledger/ledger.service';
import { PaymentsService } from './payments.service';

const scope: TxScope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '10000000-0000-4000-8000-000000000001',
};
const actor: Actor = {
  kind: 'user',
  id: '20000000-0000-4000-8000-000000000001',
  correlationId: 'c1',
};
const allow = { assert: () => undefined } as unknown as AuthzService;

/** Reached only when the service gets past the currency check and opens its transaction. */
const OPENED = new Error('transaction opened');

const body = (currency: 'NPR' | 'INR' | 'USD'): SubmitPaymentBody => ({
  customerId: '40000000-0000-4000-8000-000000000001',
  currency,
  amount: '100.00',
  tdsWithheld: '0.00',
  method: 'bank_transfer',
  receivedOn: '2026-11-19',
  proofDocumentIds: ['50000000-0000-4000-8000-000000000001'],
});

function build(currencies: CurrencyEnabledService, authz: AuthzService = allow) {
  const transaction = vi.fn(() => Promise.reject(OPENED));
  const db = { transaction } as unknown as Db;
  const service = new PaymentsService(
    db,
    authz,
    {} as MoneyService,
    {} as NumberingService,
    {} as AuditService,
    {} as LedgerService,
    currencies,
    () => new Date('2026-11-19T06:00:00Z'),
  );
  return { service, transaction };
}

/** Runs `fn` and returns what it threw. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('PaymentsService refuses a disabled currency', () => {
  it('a staff payment in a switched-off currency: 422 CURRENCY_NOT_ENABLED and no transaction', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('INR')));
    const { service, transaction } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    const error = await caught(() => service.submit(scope, actor, body('INR'), 'staff', 'key-1'));

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
      details: { currency: 'INR' },
    });
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'INR');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a portal payment in a switched-off currency is refused the same way', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('USD')));
    const { service, transaction } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    const error = await caught(() => service.submit(scope, actor, body('USD'), 'portal', 'key-2'));

    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
    });
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'USD');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a caller without permission gets 403 before the currency is looked at', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('INR')));
    const deny = {
      assert: () => {
        throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden' });
      },
    } as unknown as AuthzService;
    const { service, transaction } = build(
      { assertEnabled } as unknown as CurrencyEnabledService,
      deny,
    );

    const error = await caught(() => service.submit(scope, actor, body('INR'), 'staff', 'key-3'));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(assertEnabled).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('an enabled currency passes the check and the payment goes on to its transaction', async () => {
    const assertEnabled = vi.fn(() => Promise.resolve());
    const { service, transaction } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    await expect(service.submit(scope, actor, body('USD'), 'staff', 'key-4')).rejects.toBe(OPENED);
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'USD');
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('the real check against a saved list without INR refuses INR before the transaction', async () => {
    const settings = {
      get: (_scope: unknown, key: string) =>
        key === 'currency.enabled'
          ? Promise.resolve(['NPR', 'USD'])
          : Promise.reject(new Error(`unexpected setting ${key}`)),
    } as unknown as SettingsService;
    const { service, transaction } = build(new CurrencyEnabledService(settings));

    const error = await caught(() => service.submit(scope, actor, body('INR'), 'staff', 'key-5'));

    expect((error as UnprocessableEntityException).getResponse()).toEqual({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency INR is not enabled for this company',
      details: { currency: 'INR' },
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
