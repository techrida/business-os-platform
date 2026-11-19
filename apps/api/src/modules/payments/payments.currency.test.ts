// Unit tests: a payment in a currency the company switched off is refused before anything is written (D44), on the
// staff and the portal channel alike, only after the permission check, and a retry of a payment that already went
// through still replays its stored answer. No Docker: withTx and withIdempotency are stand-ins.
// Run with: pnpm --filter @bos/api exec vitest run src/modules/payments/payments.currency.test.ts
import type { SubmitPaymentBody } from '@bos/contracts';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// withTx and withIdempotency are stand-ins that run the callback, or replay a stored answer.
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

/** What the stubbed insert returns: reached only when the service gets past the currency check. */
const CREATED = { id: 'created' };
const created = vi.spyOn(
  PaymentsService.prototype as unknown as { submitInTx: () => Promise<unknown> },
  'submitInTx',
);
beforeEach(() => {
  state.replay = undefined;
  created.mockReset();
  created.mockResolvedValue(CREATED);
});

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
  const db = {} as unknown as Db;
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
  return { service };
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
  it('a staff payment in a switched-off currency: 422 CURRENCY_NOT_ENABLED and nothing is written', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('INR')));
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    const error = await caught(() => service.submit(scope, actor, body('INR'), 'staff', 'key-1'));

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
      details: { currency: 'INR' },
    });
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'INR');
    expect(created).not.toHaveBeenCalled();
  });

  it('a portal payment in a switched-off currency is refused the same way', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('USD')));
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    const error = await caught(() => service.submit(scope, actor, body('USD'), 'portal', 'key-2'));

    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
    });
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'USD');
    expect(created).not.toHaveBeenCalled();
  });

  it('a caller without permission gets 403 before the currency is looked at', async () => {
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('INR')));
    const deny = {
      assert: () => {
        throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden' });
      },
    } as unknown as AuthzService;
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService, deny);

    const error = await caught(() => service.submit(scope, actor, body('INR'), 'staff', 'key-3'));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(assertEnabled).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });

  it('an enabled currency passes the check and the payment goes on to its transaction', async () => {
    const assertEnabled = vi.fn(() => Promise.resolve());
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    await expect(service.submit(scope, actor, body('USD'), 'staff', 'key-4')).resolves.toBe(
      CREATED,
    );
    expect(assertEnabled).toHaveBeenCalledWith(scope, 'USD');
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('a retry of a submit that already went through replays the stored payment after the currency was switched off', async () => {
    state.replay = { id: 'stored-payment' };
    const assertEnabled = vi.fn(() => Promise.reject(currencyNotEnabled('USD')));
    const { service } = build({ assertEnabled } as unknown as CurrencyEnabledService);

    await expect(service.submit(scope, actor, body('USD'), 'portal', 'key-6')).resolves.toEqual({
      id: 'stored-payment',
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

    const error = await caught(() => service.submit(scope, actor, body('INR'), 'staff', 'key-5'));

    expect((error as UnprocessableEntityException).getResponse()).toEqual({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency INR is not enabled for this company',
      details: { currency: 'INR' },
    });
    expect(created).not.toHaveBeenCalled();
  });
});
