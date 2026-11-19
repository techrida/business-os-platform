// Unit tests of the currency check on a vendor quotation, typed in or converted from an inbox submission (D44),
// with a fake database (no Docker). The real CurrencyEnabledService and SettingsService read `currency.enabled`
// from the fake: a saved row when the test gives one, otherwise none, so the default list comes from the contract.
// The rest of the quotation write is covered by sourcing.integration.test.ts; here the first database step after
// the check throws a sentinel, which proves the check let the quotation through.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/sourcing/sourcing.currency.test.ts
import 'reflect-metadata';

import type { RecordQuotationBody } from '@bos/contracts';
import { UnprocessableEntityException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../../../platform/db/db.module';
import { SettingsService } from '../../../platform/settings/settings.service';
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
const dialect = new PgDialect();
/** Thrown by the first database step after the currency check. */
const REACHED = new Error('reached the step after the currency check');

const fields = (currency: RecordQuotationBody['currency']) => ({
  currency,
  lines: [{ prLineId: id(8), quantity: '2', unitPrice: '100.00', taxCodeId: id(9) }],
});
const recordBody = (currency: RecordQuotationBody['currency']): RecordQuotationBody => ({
  vendorId: VENDOR,
  documentId: DOC,
  ...fields(currency),
});

/** The service over a Db whose settings read answers `saved` (null: nothing saved) and counts the reads. */
function setup(saved: string[] | null) {
  const settingsReads: unknown[][] = [];
  const db = {
    execute: (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (!text.includes('FROM app.settings')) throw new Error(`unexpected query: ${text}`);
      settingsReads.push(params);
      return Promise.resolve({ rows: saved ? [{ version: 2, value: saved }] : [] });
    },
  } as unknown as Db;
  const caller = {
    current: () => ({
      scope,
      actor: { kind: 'user' as const, id: USER, correlationId: 'c' },
      principal: { userId: USER },
    }),
  };
  const service = new SourcingService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new SettingsService(db),
    caller as never,
  );
  return { service, settingsReads };
}

/** A transaction whose every select, insert and update throws REACHED. */
function unreachableTx() {
  const step = vi.fn(() => {
    throw REACHED;
  });
  return { tx: { select: step, insert: step, update: step }, step };
}

/**
 * A transaction that locks one `received` submission and finds its file clean, then throws REACHED on the next
 * select (the RFQ read in insertQuotation) and on any insert or update.
 */
function submissionTx() {
  const sub = {
    id: SUB,
    ...scope,
    status: 'received',
    rfqId: RFQ,
    vendorId: VENDOR,
    documentId: DOC,
  };
  const chain = { from: () => chain, where: () => chain, for: () => Promise.resolve([sub]) };
  const step = vi.fn(() => {
    throw REACHED;
  });
  const select = vi
    .fn<() => unknown>(() => {
      throw REACHED;
    })
    .mockImplementationOnce(() => chain);
  const execute = vi.fn(() => Promise.resolve({ rows: [{ status: 'clean' }] }));
  return { tx: { select, execute, insert: step, update: step }, step };
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function expectNotEnabled(error: unknown, currency: string) {
  expect(error).toBeInstanceOf(UnprocessableEntityException);
  expect((error as UnprocessableEntityException).getStatus()).toBe(422);
  expect((error as UnprocessableEntityException).getResponse()).toEqual({
    code: 'CURRENCY_NOT_ENABLED',
    message: `Currency ${currency} is not enabled for this company`,
    details: { currency },
  });
}

describe('SourcingService.recordQuotation currency check (D44)', () => {
  it('refuses a currency the company switched off with 422 and touches no table', async () => {
    const { service, settingsReads } = setup(['NPR', 'USD']);
    const { tx, step } = unreachableTx();
    TX = tx;
    expectNotEnabled(
      await caught(() => service.recordQuotation(RFQ, recordBody('INR'), 'k1')),
      'INR',
    );
    expect(step).not.toHaveBeenCalled();
    expect(settingsReads).toEqual([[scope.tenantId, scope.organizationId, 'currency.enabled']]);
  });

  it('lets a currency of the default list (nothing saved) through to the RFQ read', async () => {
    const { service } = setup(null);
    const { tx, step } = unreachableTx();
    TX = tx;
    expect(await caught(() => service.recordQuotation(RFQ, recordBody('USD'), 'k2'))).toBe(REACHED);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('lets NPR through without reading the setting', async () => {
    const { service, settingsReads } = setup(['USD']);
    TX = unreachableTx().tx;
    expect(await caught(() => service.recordQuotation(RFQ, recordBody('NPR'), 'k3'))).toBe(REACHED);
    expect(settingsReads).toEqual([]);
  });
});

describe('SourcingService.convertSubmission currency check (D44)', () => {
  it('refuses a currency the company switched off with 422 and converts nothing', async () => {
    const { service } = setup(['NPR', 'USD']);
    const { tx, step } = submissionTx();
    TX = tx;
    const body = { submissionId: SUB, ...fields('INR') };
    expectNotEnabled(await caught(() => service.convertSubmission(RFQ, body, 'k4')), 'INR');
    // Only the submission lock ran: no RFQ read, no quotation insert, no submission update.
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(step).not.toHaveBeenCalled();
  });

  it('lets a currency of the default list (nothing saved) through', async () => {
    const { service } = setup(null);
    const { tx } = submissionTx();
    TX = tx;
    const body = { submissionId: SUB, ...fields('INR') };
    expect(await caught(() => service.convertSubmission(RFQ, body, 'k5'))).toBe(REACHED);
    expect(tx.select).toHaveBeenCalledTimes(2);
  });
});
