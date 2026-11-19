// Unit tests: a vendor's quotation or bill in a currency the company switched off is refused with 422
// CURRENCY_NOT_ENABLED before any inbox row is written (D44), only after the vendor's access and the body were checked,
// and a retry of a submission that already went through still replays its stored answer. No Docker: withTx and
// withIdempotency are stand-ins, the transaction is a chainable fake whose `insert` is a spy.
// Run with: pnpm --filter @bos/api exec vitest run src/modules/portal-vendor/inbox/portal-vendor-inbox.currency.test.ts
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Db } from '../../../platform/db/db.module';
import type { Actor, TxScope } from '../../../platform/db/tx';
import type { DocumentsService } from '../../../platform/documents/documents.service';
import {
  currencyNotEnabled,
  CurrencyEnabledService,
} from '../../../platform/settings/currency-enabled';
import type { SettingsService } from '../../../platform/settings/settings.service';
import type { VendorPortalCaller } from '../../portal/vendor-portal.caller';
import type { VendorBankService } from '../../vendors/bank/bank.service';
import { VendorPortalInboxService, type InboxReceipt } from './portal-vendor-inbox.service';

const scope: TxScope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '10000000-0000-4000-8000-000000000001',
};
const actor: Actor = {
  kind: 'user',
  id: '20000000-0000-4000-8000-000000000001',
  correlationId: 'c1',
};
const who = { scope, actor };
const PARTY = '30000000-0000-4000-8000-000000000001';
const RFQ = '40000000-0000-4000-8000-000000000001';
const DOC = '50000000-0000-4000-8000-000000000001';
const ROW = '60000000-0000-4000-8000-000000000001';
const RECEIVED_AT = new Date('2026-11-20T06:00:00Z');

// withTx and withIdempotency are stand-ins that run the callback, or replay a stored answer.
const state = vi.hoisted((): { replay: unknown; tx: unknown } => ({
  replay: undefined,
  tx: undefined,
}));
vi.mock('../../../platform/db/tx', () => ({
  withTx: (_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
    fn(state.tx),
}));
vi.mock('../../../platform/db/idempotency', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform/db/idempotency')>()),
  withIdempotency: async (
    _tx: unknown,
    _input: unknown,
    fn: () => Promise<{ response: unknown }>,
  ) =>
    state.replay === undefined ? fn() : { status: 201, response: state.replay, replayed: true },
}));

/** A transaction whose reads find the caller invited to an open RFQ and whose insert returns one inbox row. */
function fakeTx() {
  const select = vi.fn(() => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      for: () => Promise.resolve([{ id: 'invited' }]),
    };
    return chain;
  });
  const insert = vi.fn(() => ({
    values: () => ({ returning: () => Promise.resolve([{ id: ROW, receivedAt: RECEIVED_AT }]) }),
  }));
  return { select, insert };
}

// The vendor's live status lookup and the file check have their own tests; here they pass.
const access = vi.spyOn(
  VendorPortalInboxService.prototype as unknown as { access: () => Promise<unknown> },
  'access',
);
vi.spyOn(
  VendorPortalInboxService.prototype as unknown as { assertDocument: () => Promise<void> },
  'assertDocument',
).mockResolvedValue(undefined);

let tx: ReturnType<typeof fakeTx>;
beforeEach(() => {
  state.replay = undefined;
  tx = fakeTx();
  state.tx = tx;
  access.mockReset();
  access.mockResolvedValue({ p: { userId: actor.id }, partyId: PARTY });
});

function build(currencies: CurrencyEnabledService) {
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const service = new VendorPortalInboxService(
    {} as Db,
    {} as DocumentsService,
    audit as unknown as AuditService,
    {} as VendorPortalCaller,
    {} as VendorBankService,
    currencies,
  );
  return { service, audit };
}

const quotation = (currency: string) => ({
  rfqId: RFQ,
  currency,
  total: '1500.00',
  documentId: DOC,
});
const bill = (currency: string) => ({
  vendorInvoiceNo: 'INV-7',
  invoiceDate: '2026-11-19',
  currency,
  claimedTotal: '1500.00',
  documentId: DOC,
});

const RECEIPT: InboxReceipt = {
  id: ROW,
  documentId: DOC,
  status: 'received',
  receivedAt: RECEIVED_AT.toISOString(),
};

/** Runs `fn` and returns what it threw. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const refuse = (currency: string) =>
  ({
    assertEnabled: vi.fn(() => Promise.reject(currencyNotEnabled(currency))),
  }) as unknown as CurrencyEnabledService & { assertEnabled: ReturnType<typeof vi.fn> };
const allow = () =>
  ({ assertEnabled: vi.fn(() => Promise.resolve()) }) as unknown as CurrencyEnabledService & {
    assertEnabled: ReturnType<typeof vi.fn>;
  };

describe('VendorPortalInboxService.submitQuotation refuses a disabled currency', () => {
  it('a quotation in a switched-off currency: 422 CURRENCY_NOT_ENABLED, no RFQ read and no inbox row', async () => {
    const currencies = refuse('USD');
    const { service, audit } = build(currencies);

    const error = await caught(() => service.submitQuotation(who, quotation('USD'), 'key-1'));

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
      details: { currency: 'USD' },
    });
    expect(currencies.assertEnabled).toHaveBeenCalledWith(scope, 'USD');
    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('an enabled currency passes and the inbox row is written', async () => {
    const currencies = allow();
    const { service, audit } = build(currencies);

    await expect(service.submitQuotation(who, quotation('INR'), 'key-2')).resolves.toEqual(RECEIPT);
    expect(currencies.assertEnabled).toHaveBeenCalledWith(scope, 'INR');
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('a retry of a submission that already went through replays its answer after the currency was switched off', async () => {
    state.replay = RECEIPT;
    const { service } = build(refuse('USD'));

    await expect(service.submitQuotation(who, quotation('USD'), 'key-3')).resolves.toEqual(RECEIPT);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('a caller the vendor status refuses gets 403 before the currency is looked at', async () => {
    access.mockRejectedValueOnce(new ForbiddenException({ code: 'forbidden' }));
    const currencies = refuse('USD');
    const { service } = build(currencies);

    const error = await caught(() => service.submitQuotation(who, quotation('USD'), 'key-4'));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(currencies.assertEnabled).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('the real check against a saved list without USD refuses USD', async () => {
    const settings = {
      get: (_scope: unknown, key: string) =>
        key === 'currency.enabled'
          ? Promise.resolve(['NPR', 'INR'])
          : Promise.reject(new Error(`unexpected setting ${key}`)),
    } as unknown as SettingsService;
    const { service } = build(new CurrencyEnabledService(settings));

    const error = await caught(() => service.submitQuotation(who, quotation('USD'), 'key-5'));

    expect((error as UnprocessableEntityException).getResponse()).toEqual({
      code: 'CURRENCY_NOT_ENABLED',
      message: 'Currency USD is not enabled for this company',
      details: { currency: 'USD' },
    });
    expect(tx.insert).not.toHaveBeenCalled();
    // NPR is the books' currency: always accepted.
    await expect(service.submitQuotation(who, quotation('NPR'), 'key-6')).resolves.toEqual(RECEIPT);
  });
});

describe('VendorPortalInboxService.submitBill refuses a disabled currency', () => {
  it('a bill in a switched-off currency: 422 CURRENCY_NOT_ENABLED and no inbox row', async () => {
    const currencies = refuse('INR');
    const { service, audit } = build(currencies);

    const error = await caught(() => service.submitBill(who, bill('INR'), 'key-7'));

    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'CURRENCY_NOT_ENABLED',
      details: { currency: 'INR' },
    });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('an enabled currency passes, and a retry after it was switched off replays', async () => {
    const { service } = build(allow());
    await expect(service.submitBill(who, bill('USD'), 'key-8')).resolves.toEqual(RECEIPT);
    expect(tx.insert).toHaveBeenCalledTimes(1);

    tx.insert.mockClear();
    state.replay = RECEIPT;
    const { service: after } = build(refuse('USD'));
    await expect(after.submitBill(who, bill('USD'), 'key-8')).resolves.toEqual(RECEIPT);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
