// Unit tests of the RFQ quotation deadline (F1-Q47) with a fake database (no Docker): a quotation typed in after
// the deadline, a vendor upload received after it, and Procurement extending it. The first database step after the
// deadline check throws a sentinel, which proves the check let the quotation through. The full write is covered by
// sourcing.integration.test.ts and sourcing.more.integration.test.ts.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/sourcing/sourcing.deadline.test.ts
import 'reflect-metadata';

import type { RecordQuotationBody } from '@bos/contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../../../platform/db/db.module';
import { RFQ_DEADLINE_PASSED_MESSAGE } from './sourcing.rules';
import { SourcingService } from './sourcing.service';

/** What withTx hands the service; each test sets the fake transaction it needs. */
let TX: unknown;

vi.mock('../../../platform/db/tx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform/db/tx')>()),
  withTx: vi.fn((_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
    fn(TX),
  ),
}));
vi.mock('../../../platform/db/idempotency', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform/db/idempotency')>()),
  withIdempotency: vi.fn(
    async (tx: unknown, _input: unknown, fn: (tx: unknown) => Promise<unknown>) => ({
      ...((await fn(tx)) as object),
      replayed: false,
    }),
  ),
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { tenantId: id(1), organizationId: id(2) };
const USER = id(3);
const RFQ = id(4);
const VENDOR = id(5);
const DOC = id(6);
const SUB = id(7);
const PR = id(10);
/** Thrown by the first database step after the deadline check. */
const REACHED = new Error('reached the step after the deadline check');

/** 20 Nov 2026, 10:00 in Kathmandu. */
const DEADLINE = new Date('2026-11-20T04:15:00.000Z');
const rfqRow = (over: Record<string, unknown> = {}) => ({
  id: RFQ,
  ...scope,
  purchaseRequestId: PR,
  number: 'RFQ-2082/83-00001',
  deadline: DEADLINE,
  status: 'open',
  recommendedQuotationId: null,
  fewerThanThreeReason: null,
  recommendationRationale: null,
  commitmentApprovalRequestId: null,
  version: 1,
  ...over,
});

const fields = {
  currency: 'NPR' as const,
  lines: [{ prLineId: id(8), quantity: '2', unitPrice: '100.00', taxCodeId: id(9) }],
};
const recordBody: RecordQuotationBody = { vendorId: VENDOR, documentId: DOC, ...fields };

function setup(now: Date) {
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const caller = {
    current: () => ({
      scope,
      actor: { kind: 'user' as const, id: USER, correlationId: 'c' },
      principal: { userId: USER },
    }),
  };
  const service = new SourcingService(
    {} as Db,
    {} as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    caller as never,
    () => now,
  );
  return { service, audit };
}

/** A `select ... for update` that answers `row`. */
const locked = (row: unknown) => {
  const chain = { from: () => chain, where: () => chain, for: () => Promise.resolve([row]) };
  return chain;
};

/** A transaction that locks the RFQ, then throws REACHED on any other read or write. */
function rfqTx(rfq: unknown) {
  const step = vi.fn(() => {
    throw REACHED;
  });
  const select = vi
    .fn<() => unknown>(() => {
      throw REACHED;
    })
    .mockImplementationOnce(() => locked(rfq));
  return { tx: { select, insert: step, update: step }, select };
}

/** Locks a clean `received` submission received at `receivedAt`, then the RFQ, then throws REACHED. */
function submissionTx(receivedAt: Date, rfq: unknown) {
  const sub = {
    id: SUB,
    ...scope,
    status: 'received',
    rfqId: RFQ,
    vendorId: VENDOR,
    documentId: DOC,
    receivedAt,
  };
  const step = vi.fn(() => {
    throw REACHED;
  });
  const select = vi
    .fn<() => unknown>(() => {
      throw REACHED;
    })
    .mockImplementationOnce(() => locked(sub))
    .mockImplementationOnce(() => locked(rfq));
  const execute = vi.fn(() => Promise.resolve({ rows: [{ status: 'clean' }] }));
  return { tx: { select, execute, insert: step, update: step }, select, step };
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function expectDeadlinePassed(error: unknown) {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toEqual({
    code: 'rfq_deadline_passed',
    message: RFQ_DEADLINE_PASSED_MESSAGE,
  });
}

describe('SourcingService.recordQuotation after the deadline (F1-Q47)', () => {
  it('refuses a quotation typed in a millisecond after the deadline, before any other read', async () => {
    const { service } = setup(new Date(DEADLINE.getTime() + 1));
    const { tx, select } = rfqTx(rfqRow());
    TX = tx;
    expectDeadlinePassed(await caught(() => service.recordQuotation(RFQ, recordBody, 'k1')));
    // Only the RFQ lock ran: no invitation read, no quotation insert.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('takes a quotation typed in at the deadline itself', async () => {
    const { service } = setup(DEADLINE);
    TX = rfqTx(rfqRow()).tx;
    expect(await caught(() => service.recordQuotation(RFQ, recordBody, 'k2'))).toBe(REACHED);
  });

  it('takes a quotation again once the deadline was extended past now', async () => {
    const { service } = setup(new Date('2026-11-22T00:00:00Z'));
    TX = rfqTx(rfqRow({ deadline: new Date('2026-11-25T04:15:00Z') })).tx;
    expect(await caught(() => service.recordQuotation(RFQ, recordBody, 'k3'))).toBe(REACHED);
  });
});

describe('SourcingService.convertSubmission and the deadline (F1-Q47)', () => {
  // Staff convert long after the deadline: what counts is when the portal received the upload.
  const late = new Date('2026-12-01T00:00:00Z');

  it('converts an upload received before the deadline, however late it is converted', async () => {
    const { service } = setup(late);
    TX = submissionTx(new Date(DEADLINE.getTime() - 60_000), rfqRow()).tx;
    const body = { submissionId: SUB, ...fields };
    expect(await caught(() => service.convertSubmission(RFQ, body, 'k4'))).toBe(REACHED);
  });

  it('refuses an upload received after the deadline and marks nothing converted', async () => {
    const { service } = setup(late);
    const { tx, step } = submissionTx(new Date(DEADLINE.getTime() + 1), rfqRow());
    TX = tx;
    const body = { submissionId: SUB, ...fields };
    expectDeadlinePassed(await caught(() => service.convertSubmission(RFQ, body, 'k5')));
    expect(step).not.toHaveBeenCalled();
  });
});

/** Locks the RFQ, records the update's `set`, answers the updated row, then the invited vendors. */
function extendTx(rfq: ReturnType<typeof rfqRow>) {
  const sets: Record<string, unknown>[] = [];
  const invited = {
    from: () => invited,
    innerJoin: () => invited,
    where: () => invited,
    orderBy: () => Promise.resolve([{ id: VENDOR, name: 'Everest Supplies Pvt Ltd' }]),
  };
  const select = vi.fn<() => unknown>(() => invited).mockImplementationOnce(() => locked(rfq));
  const update = vi.fn(() => {
    const chain = {
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return chain;
      },
      where: () => chain,
      returning: () =>
        Promise.resolve([{ ...rfq, deadline: sets[0]!.deadline, version: rfq.version + 1 }]),
    };
    return chain;
  });
  return { tx: { select, update }, sets, update };
}

describe('SourcingService.extendDeadline (F1-Q47)', () => {
  const now = new Date('2026-11-21T00:00:00Z');

  it('moves the deadline of an open RFQ whose deadline passed, audited with both deadlines', async () => {
    const { service, audit } = setup(now);
    const { tx, sets } = extendTx(rfqRow());
    TX = tx;
    const dto = await service.extendDeadline(RFQ, { deadline: '2026-11-25T10:00:00+05:45' }, 'k6');
    expect(sets).toHaveLength(1);
    expect((sets[0]!.deadline as Date).toISOString()).toBe('2026-11-25T04:15:00.000Z');
    expect(dto.deadline).toBe('2026-11-25T04:15:00.000Z');
    expect(dto.status).toBe('open');
    expect(dto.version).toBe(2);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      action: 'procurement.rfq.deadline_extended',
      entityType: 'rfqs',
      entityId: RFQ,
      before: { deadline: '2026-11-20T04:15:00.000Z' },
      after: { deadline: '2026-11-25T04:15:00.000Z' },
    });
  });

  it.each(['closed', 'recommended', 'cancelled'])(
    'refuses a %s RFQ with 409 and writes nothing',
    async (status) => {
      const { service, audit } = setup(now);
      const { tx, update } = extendTx(rfqRow({ status }));
      TX = tx;
      const error = await caught(() =>
        service.extendDeadline(RFQ, { deadline: '2026-11-25T10:00:00+05:45' }, 'k7'),
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect(update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('refuses a new deadline that is not after now with deadline_in_past', async () => {
    const { service } = setup(now);
    const { tx, update } = extendTx(rfqRow());
    TX = tx;
    const error = await caught(() =>
      service.extendDeadline(RFQ, { deadline: now.toISOString() }, 'k8'),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      reason: 'deadline_in_past',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a new deadline that is not after the current one', async () => {
    const { service } = setup(now);
    const { tx, update } = extendTx(rfqRow({ deadline: new Date('2026-12-10T00:00:00Z') }));
    TX = tx;
    const error = await caught(() =>
      service.extendDeadline(RFQ, { deadline: '2026-12-05T10:00:00+05:45' }, 'k9'),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      message: 'The new deadline must be later than the current one.',
    });
    expect(update).not.toHaveBeenCalled();
  });
});
