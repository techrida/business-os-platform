// Unit tests: a manual invoice or proforma in a currency the company switched off is refused before anything is
// written (D44). No Docker: the database is a fake whose transaction only records that it was opened.
// Run with: pnpm --filter @bos/api exec vitest run src/modules/invoices/invoice-drafting.currency.test.ts
//
// Drafting from a sales order copies the order's currency and is not checked (decision for U16), so it is not here.
import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import {
  currencyNotEnabled,
  CurrencyEnabledService,
} from '../../platform/settings/currency-enabled';
import type { SettingsService } from '../../platform/settings/settings.service';
import type { LedgerService } from '../ledger/ledger.service';
import { InvoiceDraftingService } from './invoice-drafting.service';
import type { InvoiceCaller } from './invoice-support';

const scope: TxScope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '10000000-0000-4000-8000-000000000001',
};
const caller = {
  current: () => ({
    scope,
    actor: {
      kind: 'user' as const,
      id: '20000000-0000-4000-8000-000000000001',
      correlationId: 'c1',
    },
    principal: { orgKind: 'staff' },
  }),
} as unknown as InvoiceCaller;
const authz = { assert: () => undefined } as unknown as AuthzService;

/** Reached only when the service gets past the currency check and opens its transaction. */
const OPENED = new Error('transaction opened');

const line = {
  description: 'Consulting',
  uom: 'hour',
  quantity: '1',
  unitPrice: '100.00',
  taxCodeId: '30000000-0000-4000-8000-000000000001',
};
const manualBody = (currency: 'NPR' | 'INR' | 'USD') => ({
  customerId: '40000000-0000-4000-8000-000000000001',
  currency,
  manualReason: 'One-off work',
  lines: [line],
});
const proformaBody = (currency: 'NPR' | 'INR' | 'USD') => ({
  customerId: '40000000-0000-4000-8000-000000000001',
  currency,
  lines: [line],
});

function build(currencies: CurrencyEnabledService) {
  const transaction = vi.fn(() => Promise.reject(OPENED));
  const db = { transaction } as unknown as Db;
  const service = new InvoiceDraftingService(
    db,
    authz,
    {} as AuditService,
    caller,
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

describe('InvoiceDraftingService refuses a disabled currency', () => {
  it('a manual invoice in a switched-off currency: 422 CURRENCY_NOT_ENABLED and no transaction', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('INR')));
    const { service, transaction } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    const error = await caught(() => service.draftManual(manualBody('INR'), 'key-1'));

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
      details: { currency: 'INR' },
    });
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'INR');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a proforma in a switched-off currency is refused the same way', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('USD')));
    const { service, transaction } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    const error = await caught(() => service.draftProforma(proformaBody('USD'), 'key-2'));

    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
    });
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'USD');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('an enabled currency passes the check and the draft goes on to its transaction', async () => {
    const assertEnabled = vi.fn(() => Promise.resolve());
    const { service, transaction } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    await expect(service.draftManual(manualBody('USD'), 'key-3')).rejects.toBe(OPENED);
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

    const error = await caught(() => service.draftManual(manualBody('INR'), 'key-4'));

    expect((error as UnprocessableEntityException).getResponse()).toEqual({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency INR is not enabled for this company',
      details: { currency: 'INR' },
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
