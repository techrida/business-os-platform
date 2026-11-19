// Unit tests: TestMemoService refuses a currency the company switched off (D44), with a fake database (no Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/modules/test-memo/test-memo.currency-enabled.test.ts
//
// The real TestMemoService.create/update run against a fake Db. Settings are read by the real SettingsService
// from that fake: `currency.enabled` answers the saved list a test gives, otherwise no rows, so the default list
// comes from the real contract SETTING_DEFAULTS. Numbering, money, authz and the caller are fakes; the SQL scoping
// itself is covered by test-memo.integration.test.ts against a real database.
import type { testMemos } from '@bos/db';
import { UnprocessableEntityException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalsService } from '../approvals/requests.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import type { DocumentsService } from '../../platform/documents/documents.service';
import type { MoneyService } from '../../platform/settings/money.service';
import type { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import type { TestMemoCaller } from './test-memo.caller';
import { TestMemoService } from './test-memo.service';

type MemoRow = typeof testMemos.$inferSelect;

const TENANT = '0a000000-0000-4000-8000-000000000001';
const ENTITY = '0a000000-0000-4000-8000-000000000002';
const USER = '0a000000-0000-4000-8000-000000000003';
const MEMO = '0a000000-0000-4000-8000-000000000004';
const scope = { tenantId: TENANT, organizationId: ENTITY };
const now = new Date('2026-11-19T06:00:00.000Z');
const dialect = new PgDialect();

const principal = {
  userId: USER,
  tenantId: TENANT,
  organizationId: ENTITY,
  orgKind: 'staff',
  status: 'active',
  partyId: null,
  departmentId: null,
  roles: ['sales'],
} as unknown as Principal;

/** A stored legacy draft memo of the caller, in `currency`. */
function storedMemo(currency: string): MemoRow {
  return {
    id: MEMO,
    tenantId: TENANT,
    organizationId: ENTITY,
    template: null,
    number: 'MEMO-2082/83-00001',
    title: 'Laptop for the field team',
    body: '',
    amount: '100.00',
    currency,
    amountNpr: '13300.00',
    fxRate: '133.000000',
    fxSource: 'manual',
    fxDate: '2026-11-18',
    status: 'draft',
    ownerUserId: USER,
    departmentId: null,
    customerPartyId: null,
    editorUserIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    discardedAt: null,
    discardedByUserId: null,
  } as unknown as MemoRow;
}

/**
 * The service over a fake Db. `enabled` is the saved `currency.enabled` list (null: nothing saved). `stored` is the
 * memo row the update path locks. Records the settings keys read, and the inserted and updated values.
 */
function harness(enabled: readonly string[] | null, stored?: MemoRow) {
  const settingsReads: unknown[] = [];
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const tx = {
    execute: () => Promise.resolve({ rows: [] }),
    select: () => ({
      from: () => ({ where: () => ({ for: () => Promise.resolve(stored ? [stored] : []) }) }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          inserted.push(values);
          return Promise.resolve([{ id: MEMO, editorUserIds: [], template: null, ...values }]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            updated.push(values);
            return Promise.resolve([{ ...stored!, ...values }]);
          },
        }),
      }),
    }),
  };
  let inTransaction = false;
  const db = {
    // SettingsService reads through the pool with raw SQL; the third parameter is the setting key. A pool read
    // while the transaction is open would hold a second connection under the row lock, so the fake refuses it.
    execute: (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (!text.includes('FROM app.settings')) throw new Error(`unexpected query: ${text}`);
      if (inTransaction) throw new Error('settings read through the pool inside the transaction');
      const key = params[2];
      settingsReads.push(key);
      return Promise.resolve({
        rows:
          key === 'currency.enabled' && enabled !== null
            ? [{ version: 2, value: [...enabled] }]
            : [],
      });
    },
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await fn(tx);
      } finally {
        inTransaction = false;
      }
    },
  } as unknown as Db;
  const numbering = {
    issue: vi
      .fn()
      .mockResolvedValue({ number: 'MEMO-2082/83-00002', seq: 2, fiscalYear: '2082/83' }),
  } as unknown as NumberingService;
  const money = {
    toNprSnapshot: vi.fn().mockResolvedValue({
      amountNpr: '13300.00',
      rate: '133',
      rateSource: 'manual',
      rateDate: '2026-11-18',
    }),
  } as unknown as MoneyService;
  const caller = {
    current: () => ({
      scope,
      actor: { kind: 'user', id: USER, correlationId: 'corr-1' },
      principal,
    }),
  } as unknown as TestMemoCaller;
  const service = new TestMemoService(
    db,
    numbering,
    money,
    {} as DocumentsService,
    {} as ApprovalsService,
    { assert: () => undefined } as unknown as AuthzService,
    {} as RoleCache,
    caller,
    () => now,
    new SettingsService(db),
  );
  return { service, settingsReads, inserted, updated, numbering };
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

function expectNotEnabled(error: unknown, currency: string): void {
  expect(error).toBeInstanceOf(UnprocessableEntityException);
  expect((error as UnprocessableEntityException).getStatus()).toBe(422);
  expect((error as UnprocessableEntityException).getResponse()).toEqual({
    code: 'CURRENCY_NOT_ENABLED',
    message: `Currency ${currency} is not enabled for this company`,
    details: { currency },
  });
}

describe('TestMemoService.create: enabled currencies (D44)', () => {
  it('refuses a switched-off currency with 422 before taking a number', async () => {
    const h = harness(['NPR', 'INR']);
    const error = await caught(() =>
      h.service.create({ title: 'Laptop', body: '', amount: '100.00', currency: 'USD' }),
    );
    expectNotEnabled(error, 'USD');
    expect(h.numbering.issue).not.toHaveBeenCalled();
    expect(h.inserted).toEqual([]);
  });

  it('accepts a currency of the default list when nothing is saved', async () => {
    const h = harness(null);
    const memo = await h.service.create({
      title: 'Laptop',
      body: '',
      amount: '100.00',
      currency: 'USD',
    });
    expect(memo.currency).toBe('USD');
    expect(h.inserted).toHaveLength(1);
    expect(h.settingsReads).toContain('currency.enabled');
  });
});

describe('TestMemoService.update: enabled currencies (D44)', () => {
  it('refuses a change to a switched-off currency with 422 and writes nothing', async () => {
    const h = harness(['NPR', 'INR'], storedMemo('INR'));
    const error = await caught(() => h.service.update(MEMO, { currency: 'USD' }));
    expectNotEnabled(error, 'USD');
    expect(h.updated).toEqual([]);
  });

  it('still saves a memo whose currency was switched off later when the currency is unchanged', async () => {
    const h = harness(['NPR', 'INR'], storedMemo('USD'));
    const resent = await h.service.update(MEMO, { title: 'Two laptops', currency: 'USD' });
    expect(resent.title).toBe('Two laptops');
    const titleOnly = await h.service.update(MEMO, { title: 'Three laptops' });
    expect(titleOnly.title).toBe('Three laptops');
    expect(h.updated).toHaveLength(2);
    // The resent currency was read (and refused) before the lock, but the stored currency matched, so it saved.
    expect(h.settingsReads).toContain('currency.enabled');
  });

  it('accepts a change to a currency of the default list when nothing is saved', async () => {
    const h = harness(null, storedMemo('INR'));
    const memo = await h.service.update(MEMO, { currency: 'USD' });
    expect(memo.currency).toBe('USD');
    expect(h.updated).toHaveLength(1);
    expect(h.settingsReads).toContain('currency.enabled');
  });
});
