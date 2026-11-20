// Unit tests: payments are exempt from the switched-off currency rule (D56 U16-Q1, an exception to D44). Money
// that has arrived must always be recordable, so a staff or portal payment in a currency the company switched off
// goes on to its transaction, while the permission check still runs first. No Docker: withTx and withIdempotency
// are stand-ins, and the insert is a spy.
// Run with: pnpm --filter @bos/api exec vitest run src/modules/payments/payments.currency.test.ts
import type { SubmitPaymentBody } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Db } from '../../platform/db/db.module';
import type { Actor, TxScope } from '../../platform/db/tx';
import type { MoneyService } from '../../platform/settings/money.service';
import type { NumberingService } from '../../platform/settings/numbering.service';
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

vi.mock('../../platform/db/tx', () => ({
  withTx: (_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../../platform/db/idempotency', () => ({
  withIdempotency: async (
    _tx: unknown,
    _input: unknown,
    fn: () => Promise<{ response: unknown }>,
  ) => fn(),
}));

/** What the stubbed insert returns: reached only when nothing refused the payment first. */
const CREATED = { id: 'created' };
const created = vi.spyOn(
  PaymentsService.prototype as unknown as { submitInTx: () => Promise<unknown> },
  'submitInTx',
);
beforeEach(() => {
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

function build(authz: AuthzService = allow): PaymentsService {
  return new PaymentsService(
    {} as unknown as Db,
    authz,
    {} as MoneyService,
    {} as NumberingService,
    {} as AuditService,
    {} as LedgerService,
    () => new Date('2026-11-19T06:00:00Z'),
  );
}

describe('PaymentsService accepts a payment in a switched-off currency', () => {
  it.each([
    ['staff', 'USD'],
    ['staff', 'INR'],
    ['portal', 'USD'],
    ['portal', 'INR'],
  ] as const)('a %s payment in %s goes on to its transaction', async (channel, currency) => {
    await expect(build().submit(scope, actor, body(currency), channel, 'key-1')).resolves.toBe(
      CREATED,
    );
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0]?.[3]).toMatchObject({ currency });
  });

  it('a caller without permission still gets 403 and nothing is written', async () => {
    const deny = {
      assert: () => {
        throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden' });
      },
    } as unknown as AuthzService;

    await expect(
      build(deny).submit(scope, actor, body('USD'), 'staff', 'key-2'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(created).not.toHaveBeenCalled();
  });
});
