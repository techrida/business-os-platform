// Unit tests of the currency check on a purchase request's create and update (D44), with a fake database (no
// Docker). The real CurrencyEnabledService and SettingsService read `currency.enabled` from the fake: a saved row
// when the test gives one, otherwise none, so the default list comes from the contract, not from this file.
// The rest of create and update (rows, lines, audit) is covered by purchase-requests.integration.test.ts; here the
// first database step after the check throws a sentinel, which proves the check let the request through.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/requests/purchase-requests.currency.test.ts
import 'reflect-metadata';

import type { CreatePurchaseRequestBody } from '@bos/contracts';
import { UnprocessableEntityException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthzService } from '../../../platform/authz/authz.service';
import type { Db } from '../../../platform/db/db.module';
import { PurchaseRequestsService } from './purchase-requests.service';

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
const DEPT = id(4);
const CC = id(5);
const PR = id(6);
const dialect = new PgDialect();
/** Thrown by the first database step after the currency check. */
const REACHED = new Error('reached the step after the currency check');

const body = (currency: CreatePurchaseRequestBody['currency']): CreatePurchaseRequestBody => ({
  requestType: 'goods',
  departmentId: DEPT,
  costCenterId: CC,
  justification: 'Laptops for the new hires',
  requiredBy: '2026-12-01',
  budgetCode: 'IT-2026',
  currency,
  isEmergency: false,
  lines: [{ description: 'Laptop', quantity: '2', uom: 'pcs', estimatedUnitPrice: '1000.00' }],
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
  const authz = { assert: vi.fn() } as unknown as AuthzService;
  const service = new PurchaseRequestsService(
    db,
    authz,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    caller as never,
  );
  return { service, settingsReads };
}

/** A transaction whose every select, insert and delete throws REACHED. */
function unreachableTx() {
  const step = vi.fn(() => {
    throw REACHED;
  });
  return { tx: { select: step, insert: step, delete: step }, step };
}

/** A transaction that locks one draft request in `currency`, then throws REACHED on the next step. */
function lockedTx(currency: string) {
  const row = {
    id: PR,
    ...scope,
    requesterUserId: USER,
    departmentId: DEPT,
    costCenterId: CC,
    status: 'draft',
    version: 1,
    currency,
  };
  const lockChain = {
    from: () => lockChain,
    where: () => lockChain,
    for: () => Promise.resolve([row]),
  };
  const select = vi.fn(() => lockChain);
  const step = vi.fn(() => {
    throw REACHED;
  });
  return { tx: { select, insert: step, delete: step }, step };
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

describe('PurchaseRequestsService.create currency check (D44)', () => {
  it('refuses a currency the company switched off with 422 and touches no table', async () => {
    const { service, settingsReads } = setup(['NPR', 'USD']);
    const { tx, step } = unreachableTx();
    TX = tx;
    expectNotEnabled(await caught(() => service.create(body('INR'), 'k1')), 'INR');
    expect(step).not.toHaveBeenCalled();
    expect(settingsReads).toEqual([[scope.tenantId, scope.organizationId, 'currency.enabled']]);
  });

  it('lets a currency of the default list (nothing saved) through to the department check', async () => {
    const { service } = setup(null);
    const { tx, step } = unreachableTx();
    TX = tx;
    expect(await caught(() => service.create(body('USD'), 'k2'))).toBe(REACHED);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('lets NPR through without reading the setting', async () => {
    const { service, settingsReads } = setup(['USD']);
    TX = unreachableTx().tx;
    expect(await caught(() => service.create(body('NPR'), 'k3'))).toBe(REACHED);
    expect(settingsReads).toEqual([]);
  });
});

describe('PurchaseRequestsService.update currency check (D44)', () => {
  it('refuses a change to a currency the company switched off with 422 before any write', async () => {
    const { service } = setup(['NPR', 'USD']);
    const { tx, step } = lockedTx('USD');
    TX = tx;
    expectNotEnabled(await caught(() => service.update(PR, body('INR'), 1, 'k4')), 'INR');
    expect(step).not.toHaveBeenCalled();
  });

  it('keeps a stored currency that was switched off later, without reading the setting', async () => {
    const { service, settingsReads } = setup(['NPR', 'USD']);
    TX = lockedTx('INR').tx;
    expect(await caught(() => service.update(PR, body('INR'), 1, 'k5'))).toBe(REACHED);
    expect(settingsReads).toEqual([]);
  });

  it('lets a change to a currency of the default list (nothing saved) through', async () => {
    const { service, settingsReads } = setup(null);
    TX = lockedTx('NPR').tx;
    expect(await caught(() => service.update(PR, body('INR'), 1, 'k6'))).toBe(REACHED);
    expect(settingsReads).toHaveLength(1);
  });
});
