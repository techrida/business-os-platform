// Unit tests: a manual invoice or proforma in a currency the company switched off is refused before anything is
// written (D44), and a retry of a create that already succeeded still replays its stored answer. No Docker:
// withTx and withIdempotency are replaced by stand-ins that run the callback (or replay a stored answer).
// Run with: pnpm --filter @bos/api exec vitest run src/modules/invoices/invoice-drafting.currency.test.ts
//
// Drafting from a sales order copies the order's currency and is not checked (decision for U16), so it is not here.
import { UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const state = vi.hoisted(() => ({ replay: undefined as { id: string } | undefined }));
vi.mock('../../platform/db/tx', () => ({
  withTx: (_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../../platform/db/idempotency', () => ({
  withIdempotency: async (
    _tx: unknown,
    _input: unknown,
    fn: () => Promise<{ response: unknown }>,
  ) =>
    state.replay === undefined ? fn() : { status: 201, response: state.replay, replayed: true },
}));
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

/** What the stubbed insert returns: reached only when the service gets past the currency check. */
const CREATED = { id: 'created' };
const created = vi.spyOn(
  InvoiceDraftingService.prototype as unknown as { createTypedInTx: () => Promise<unknown> },
  'createTypedInTx',
);
beforeEach(() => {
  state.replay = undefined;
  created.mockReset();
  created.mockResolvedValue(CREATED);
});

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
  const transaction = vi.fn();
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
  it('a manual invoice in a switched-off currency: 422 CURRENCY_NOT_ENABLED and nothing is written', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('INR')));
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    const error = await caught(() => service.draftManual(manualBody('INR'), 'key-1'));

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
      details: { currency: 'INR' },
    });
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'INR');
    expect(created).not.toHaveBeenCalled();
  });

  it('a proforma in a switched-off currency is refused the same way', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('USD')));
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    const error = await caught(() => service.draftProforma(proformaBody('USD'), 'key-2'));

    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
    });
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'USD');
    expect(created).not.toHaveBeenCalled();
  });

  it('an enabled currency passes the check and the draft goes on to its transaction', async () => {
    const assertEnabled = vi.fn(() => Promise.resolve());
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    await expect(service.draftManual(manualBody('USD'), 'key-3')).resolves.toBe(CREATED);
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'USD');
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('a retry of a create that already succeeded replays its stored answer after the currency was switched off', async () => {
    state.replay = { id: 'stored-invoice' };
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('USD')));
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    await expect(service.draftManual(manualBody('USD'), 'key-5')).resolves.toEqual({
      id: 'stored-invoice',
    });
    expect(created).not.toHaveBeenCalled();
  });

  it('the real check against a saved list without INR refuses INR', async () => {
    const settings = {
      get: (_scope: unknown, key: string) =>
        key === 'currency.enabled'
          ? Promise.resolve(['NPR', 'USD'])
          : Promise.reject(new Error(`unexpected setting ${key}`)),
    } as unknown as SettingsService;
    const { service } = build(new CurrencyEnabledService(settings));

    const error = await caught(() => service.draftManual(manualBody('INR'), 'key-4'));

    expect((error as UnprocessableEntityException).getResponse()).toEqual({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency INR is not enabled for this company',
      details: { currency: 'INR' },
    });
    expect(created).not.toHaveBeenCalled();
  });
});
