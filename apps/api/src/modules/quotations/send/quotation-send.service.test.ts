// Unit tests of QuotationSendService with the database, opportunities and notify faked: the send rules (each
// blocker is a 409 with its own code, the recipient is a 400) and what one send writes, in which order. The SQL
// (scoped reads, S2's approved -> sent guard, the outbox row, the 404 for another entity) runs on Postgres in
// quotation-send.integration.test.ts.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { withTx } from '../../../platform/db/tx';
import type { QuotationVersionRow } from '../drafting/mapping';
import { QuotationSendService, type SendHead } from './quotation-send.service';

const TX = { fake: 'tx' } as unknown as DbTransaction;

vi.mock('../../../platform/db/tx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform/db/tx')>()),
  withTx: vi.fn((_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
    fn(TX),
  ),
}));
vi.mock('../../../platform/db/idempotency', () => ({
  withIdempotency: vi.fn(),
  updateVersioned: vi.fn(),
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1);
const ORG = id(2);
const QID = id(10);
const VID = id(11);
const CUSTOMER = id(20);
const CONTACT = id(21);
const OPPORTUNITY = id(30);
const DOCUMENT = id(40);
const OWNER = id(50);
const CALLER = id(51);
/** 09:00 in Kathmandu on 9 Nov 2026. */
const NOW = new Date('2026-11-09T03:15:00.000Z');
const T0 = new Date('2026-11-01T08:00:00.000Z');
const SCOPE = { tenantId: TENANT, organizationId: ORG };
const ACTOR = { kind: 'user' as const, id: CALLER };

const versionRow = (over: Partial<QuotationVersionRow> = {}): QuotationVersionRow => ({
  documentStyle: null,
  id: VID,
  tenantId: TENANT,
  organizationId: ORG,
  quotationId: QID,
  revisionNo: 1,
  status: 'approved',
  rejectionSource: null,
  contactId: null,
  templateId: null,
  currency: 'NPR',
  issueDate: '2026-11-01',
  validUntil: '2026-11-16',
  scope: null,
  assumptions: null,
  exclusions: null,
  deliveryTimeline: null,
  paymentTermId: null,
  paymentSchedule: [],
  discountMode: null,
  discountInput: null,
  subtotal: '1000.00',
  discountAmount: '0.00',
  taxableAmount: '1000.00',
  taxAmount: '130.00',
  total: '1130.00',
  effectiveDiscountPct: '0.0000',
  fxRate: '1.000000',
  fxSource: null,
  fxDate: null,
  amountNpr: '1130.00',
  nprTaxableAmount: '1000.00',
  internalCostTotal: null,
  marginPct: null,
  calcVersion: 1,
  contentSha256: Buffer.alloc(32, 1),
  snapshotSha256: Buffer.alloc(32, 2),
  approvalRequestId: null,
  renderedDocumentId: DOCUMENT,
  renderedSha256: Buffer.alloc(32, 3),
  renderState: 'rendered',
  supersedesVersionId: null,
  supersededByVersionId: null,
  revisionReason: null,
  cancelReason: null,
  submittedAt: T0,
  approvedAt: T0,
  sentAt: null,
  acceptedAt: null,
  rejectedAt: null,
  expiredAt: null,
  cancelledAt: null,
  version: 6,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const head = (over: Partial<QuotationVersionRow> = {}): SendHead => ({
  quotation: {
    id: QID,
    number: 'QT-2082/83-00042',
    tenantId: TENANT,
    organizationId: ORG,
    ownerUserId: OWNER,
    customerPartyId: CUSTOMER,
    opportunityId: OPPORTUNITY,
  },
  version: versionRow(over),
});

const BODY = { recipientContactId: CONTACT, message: 'Please review', expectedVersion: 6 };

let calls: string[];
let store: {
  load: ReturnType<typeof vi.fn>;
  renderedScanStatus: ReturnType<typeof vi.fn>;
  contact: ReturnType<typeof vi.fn>;
  customerName: ReturnType<typeof vi.fn>;
  parts: ReturnType<typeof vi.fn>;
  appendHistory: ReturnType<typeof vi.fn>;
};
let authz: { assert: ReturnType<typeof vi.fn> };
let audit: { record: ReturnType<typeof vi.fn> };
let opportunities: { markQuotationSent: ReturnType<typeof vi.fn> };
let notify: { notifyEmail: ReturnType<typeof vi.fn>; nudge: ReturnType<typeof vi.fn> };
let service: QuotationSendService;

const track =
  <T>(name: string, value: T) =>
  () => {
    calls.push(name);
    return Promise.resolve(value);
  };

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  store = {
    load: vi.fn(() => Promise.resolve(head())),
    renderedScanStatus: vi.fn(() => Promise.resolve('clean')),
    contact: vi.fn(() =>
      Promise.resolve({ id: CONTACT, fullName: 'Sita Buyer', emailNorm: 'sita@acme.example' }),
    ),
    customerName: vi.fn(() => Promise.resolve('Acme Pvt. Ltd.')),
    parts: vi.fn(() => Promise.resolve({ lines: [], taxSummary: [] })),
    appendHistory: vi.fn(track('history', undefined)),
  };
  authz = { assert: vi.fn() };
  audit = { record: vi.fn(track('audit', undefined)) };
  opportunities = { markQuotationSent: vi.fn(track('opportunity', {})) };
  notify = {
    notifyEmail: vi.fn(track('email', undefined)),
    nudge: vi.fn(track('nudge', undefined)),
  };
  vi.mocked(withIdempotency).mockImplementation(async (tx, _input, fn) => ({
    ...(await fn(tx)),
    replayed: false,
  }));
  vi.mocked(updateVersioned).mockImplementation((_tx, _table, _id, _expected, set) => {
    calls.push('status');
    return Promise.resolve(versionRow({ ...(set as Partial<QuotationVersionRow>), version: 7 }));
  });
  service = new QuotationSendService(
    {} as never,
    authz as never,
    audit as never,
    opportunities as never,
    notify as never,
    store as never,
    { current: () => ({ scope: SCOPE, actor: ACTOR }) } as never,
    () => NOW,
  );
});

const send = (body = BODY) => service.send(QID, VID, body, 'key-1');

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the send to fail');
}

const codeOf = (error: unknown) =>
  (error as ConflictException).getResponse() as { code?: string; message?: string };

describe('QuotationSendService.send', () => {
  it('sends an approved, rendered, clean version: status, history, audit, opportunity, email, then nudge', async () => {
    const dto = await send();

    expect(dto).toMatchObject({ id: VID, status: 'sent', renderedScanStatus: 'clean' });
    expect(calls).toEqual(['status', 'history', 'audit', 'opportunity', 'email', 'nudge']);
    expect(vi.mocked(withTx)).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      ACTOR,
      expect.any(Function),
    );
    expect(vi.mocked(updateVersioned)).toHaveBeenCalledWith(TX, expect.anything(), VID, 6, {
      status: 'sent',
      sentAt: NOW,
      updatedAt: NOW,
    });
    expect(store.appendHistory).toHaveBeenCalledWith(TX, {
      tenantId: TENANT,
      organizationId: ORG,
      versionId: VID,
      fromStatus: 'approved',
      toStatus: 'sent',
      actorId: CALLER,
      at: NOW,
    });
    expect(audit.record).toHaveBeenCalledWith(TX, expect.anything());
    expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
      action: 'quotation.sent',
      entityType: 'quotations',
      entityId: QID,
      before: { versionId: VID, status: 'approved' },
      after: {
        versionId: VID,
        status: 'sent',
        recipientContactId: CONTACT,
        message: 'Please review',
      },
    });
    expect(opportunities.markQuotationSent).toHaveBeenCalledWith(TX, OPPORTUNITY);
    expect(notify.notifyEmail).toHaveBeenCalledWith(TX, {
      toEmail: 'sita@acme.example',
      template: 'quotation.sent',
      data: {
        quotationNumber: 'QT-2082/83-00042',
        customerName: 'Acme Pvt. Ltd.',
        validUntil: '2026-11-16',
        linkPath: `/quotations/${QID}`,
      },
      dedupeKey: `quotation.sent:${VID}`,
    });
    expect(store.contact).toHaveBeenCalledWith(TX, TENANT, CUSTOMER, CONTACT);
    expect(store.renderedScanStatus).toHaveBeenCalledWith(TX, TENANT, DOCUMENT);
  });

  it('hashes the ids and the whole body into the idempotency claim', async () => {
    await send();
    expect(vi.mocked(withIdempotency)).toHaveBeenCalledWith(
      TX,
      {
        command: 'quotation.send',
        key: 'key-1',
        body: { quotationId: QID, versionId: VID, ...BODY },
      },
      expect.any(Function),
    );
  });

  it.each([
    ['submitted', { status: 'submitted' as const }, 'quotation_not_approved'],
    ['sent', { status: 'sent' as const }, 'quotation_not_approved'],
    ['render pending', { renderState: 'pending' as const }, 'quotation_not_rendered'],
    ['render failed', { renderState: 'failed' as const }, 'quotation_not_rendered'],
  ])('refuses a version that is %s with a 409 and writes nothing', async (_name, over, code) => {
    store.load.mockResolvedValue(head(over));
    const error = await errorOf(send());
    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error).code).toBe(code);
    expect(calls).toEqual([]);
  });

  it.each([['quarantined'], ['infected'], ['scan_failed'], [null]])(
    'refuses a rendered PDF whose scan is %s with 409 quotation_scan_not_clean',
    async (status) => {
      store.renderedScanStatus.mockResolvedValue(status);
      const error = await errorOf(send());
      expect(error).toBeInstanceOf(ConflictException);
      expect(codeOf(error).code).toBe('quotation_scan_not_clean');
      expect(calls).toEqual([]);
    },
  );

  it('refuses a quotation whose valid_until is before today in Kathmandu with 409 quotation_expired', async () => {
    // 18:30 UTC on 15 Nov is already 16 Nov 00:15 in Kathmandu.
    store.load.mockResolvedValue(head({ validUntil: '2026-11-15' }));
    service = new QuotationSendService(
      {} as never,
      authz as never,
      audit as never,
      opportunities as never,
      notify as never,
      store as never,
      { current: () => ({ scope: SCOPE, actor: ACTOR }) } as never,
      () => new Date('2026-11-15T18:30:00.000Z'),
    );
    const error = await errorOf(send());
    expect(codeOf(error).code).toBe('quotation_expired');
    expect(calls).toEqual([]);
  });

  it('still sends on the last valid day in Kathmandu', async () => {
    store.load.mockResolvedValue(head({ validUntil: '2026-11-09' }));
    await expect(send()).resolves.toMatchObject({ status: 'sent' });
  });

  it('refuses a stale expectedVersion with 409 and writes nothing', async () => {
    const error = await errorOf(send({ ...BODY, expectedVersion: 5 }));
    expect(error).toBeInstanceOf(ConflictException);
    expect(calls).toEqual([]);
  });

  it("refuses a contact that is not the customer's with 400", async () => {
    store.contact.mockResolvedValue(undefined);
    const error = await errorOf(send());
    expect(error).toBeInstanceOf(BadRequestException);
    expect(calls).toEqual([]);
  });

  it('refuses a contact without an email with 400', async () => {
    store.contact.mockResolvedValue({ id: CONTACT, fullName: 'Sita Buyer', emailNorm: null });
    const error = await errorOf(send());
    expect(error).toBeInstanceOf(BadRequestException);
    expect(calls).toEqual([]);
  });

  it('answers 404, not 403, for a quotation outside the caller scope', async () => {
    authz.assert.mockImplementation(() => {
      throw new ForbiddenException({ code: 'forbidden', reason: 'out_of_scope' });
    });
    await expect(send()).rejects.toBeInstanceOf(NotFoundException);
    expect(authz.assert).toHaveBeenCalledWith(
      'quotation.send',
      expect.objectContaining({ tenantId: TENANT, ownerUserId: OWNER, customerPartyId: CUSTOMER }),
    );
    expect(calls).toEqual([]);
  });

  it('keeps any other denial a 403', async () => {
    authz.assert.mockImplementation(() => {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_grant' });
    });
    await expect(send()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not nudge the drainer when the transaction fails', async () => {
    opportunities.markQuotationSent.mockRejectedValue(new ConflictException('lost deal'));
    await expect(send()).rejects.toBeInstanceOf(ConflictException);
    expect(notify.nudge).not.toHaveBeenCalled();
  });
});
