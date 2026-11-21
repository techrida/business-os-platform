import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('next/cache', () => cache);
const session = { accessToken: 't', orgKind: 'staff', roles: ['accountant'] } as Session;
const guard = vi.hoisted(() => ({ requireSection: vi.fn() }));
vi.mock('../guard', () => guard);
const api = vi.hoisted(() => ({
  createCompanyBankAccount: vi.fn(),
  renameCompanyBankAccount: vi.fn(),
  retireCompanyBankAccount: vi.fn(),
  reactivateCompanyBankAccount: vi.fn(),
  createExpenseAccount: vi.fn(),
  renameExpenseAccount: vi.fn(),
  retireExpenseAccount: vi.fn(),
  reactivateExpenseAccount: vi.fn(),
}));
vi.mock('@/lib/api-company-accounts', () => api);

const {
  changeBankAccountStatusAction,
  changeExpenseAccountStatusAction,
  createBankAccountAction,
  createExpenseAccountAction,
  renameBankAccountAction,
  renameExpenseAccountAction,
} = await import('./actions');
const { DUPLICATE_CODE_MESSAGE } = await import('./copy');
const { IDLE } = await import('../action-state');

const ID = '11111111-1111-4111-8111-111111111111';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const errorBody = (code: string, message: string, details?: Record<string, string>) => ({
  error: { code, message, correlationId: 'c1', ...(details ? { details } : {}) },
});

beforeEach(() => {
  vi.clearAllMocks();
  guard.requireSection.mockResolvedValue(session);
});

describe('bank account actions', () => {
  it('adds a bank account with an idempotency key, re-checking the section and refreshing the page', async () => {
    api.createCompanyBankAccount.mockResolvedValue({ id: ID, name: 'Operating account' });
    const state = await createBankAccountAction(
      IDLE,
      form({ name: ' Operating account ', bankName: 'Nabil Bank', last4: '4821', currency: 'NPR' }),
    );

    expect(guard.requireSection).toHaveBeenCalledWith('company-accounts');
    expect(api.createCompanyBankAccount).toHaveBeenCalledWith(
      session,
      { name: 'Operating account', bankName: 'Nabil Bank', last4: '4821', currency: 'NPR' },
      expect.stringMatching(UUID),
    );
    expect(state).toEqual({ status: 'ok', message: 'Added Operating account.' });
    expect(cache.revalidatePath).toHaveBeenCalledWith('/settings/company-accounts');
  });

  it('puts each problem under its field and keeps what was typed, without calling the API', async () => {
    const state = await createBankAccountAction(
      IDLE,
      form({ name: '', bankName: 'Nabil Bank', last4: '12', currency: 'NPR' }),
    );

    expect(api.createCompanyBankAccount).not.toHaveBeenCalled();
    expect(state.status).toBe('error');
    expect(state.fieldErrors).toEqual({
      name: 'Enter a name.',
      last4: 'Enter exactly four letters or digits, for example 4821.',
    });
    expect(state.fields).toMatchObject({ bankName: 'Nabil Bank', last4: '12' });
  });

  it('says what the user may not do on a 403', async () => {
    api.createCompanyBankAccount.mockRejectedValue(new ApiError(403, 'forbidden'));
    const state = await createBankAccountAction(
      IDLE,
      form({ name: 'Ops', bankName: 'Nabil Bank', last4: '4821', currency: 'NPR' }),
    );

    expect(state).toMatchObject({
      status: 'error',
      message: "You don't have permission to add bank accounts.",
    });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it('maps a 422 with field details onto those fields', async () => {
    api.createCompanyBankAccount.mockRejectedValue(
      new ApiError(
        422,
        'invalid',
        errorBody('validation_failed', 'Check the details.', { currency: 'NPR is not enabled.' }),
      ),
    );
    const state = await createBankAccountAction(
      IDLE,
      form({ name: 'Ops', bankName: 'Nabil Bank', last4: '4821', currency: 'NPR' }),
    );

    expect(state.fieldErrors).toEqual({ currency: 'NPR is not enabled.' });
  });

  it('renames by id with a fresh idempotency key', async () => {
    api.renameCompanyBankAccount.mockResolvedValue({ id: ID, name: 'Payroll' });
    const state = await renameBankAccountAction(IDLE, form({ id: ID, name: 'Payroll' }));

    expect(api.renameCompanyBankAccount).toHaveBeenCalledWith(
      session,
      ID,
      { name: 'Payroll' },
      expect.stringMatching(UUID),
    );
    expect(state.status).toBe('ok');
  });

  it('retires and reactivates through their own calls, never anything else', async () => {
    api.retireCompanyBankAccount.mockResolvedValue({ id: ID, name: 'Ops' });
    api.reactivateCompanyBankAccount.mockResolvedValue({ id: ID, name: 'Ops' });

    expect(await changeBankAccountStatusAction(ID, 'retire')).toEqual({
      status: 'ok',
      message: 'Retired Ops.',
    });
    expect(api.retireCompanyBankAccount).toHaveBeenCalledWith(
      session,
      ID,
      expect.stringMatching(UUID),
    );
    expect(await changeBankAccountStatusAction(ID, 'reactivate')).toEqual({
      status: 'ok',
      message: 'Reactivated Ops.',
    });
    expect(api.reactivateCompanyBankAccount).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed id without calling the API', async () => {
    const state = await changeBankAccountStatusAction('not-an-id', 'retire');
    expect(state.status).toBe('error');
    expect(api.retireCompanyBankAccount).not.toHaveBeenCalled();
  });
});

describe('expense account actions', () => {
  it('adds an expense account', async () => {
    api.createExpenseAccount.mockResolvedValue({ id: ID, code: '5100', name: 'Office supplies' });
    const state = await createExpenseAccountAction(
      IDLE,
      form({ code: '5100', name: 'Office supplies' }),
    );

    expect(api.createExpenseAccount).toHaveBeenCalledWith(
      session,
      { code: '5100', name: 'Office supplies' },
      expect.stringMatching(UUID),
    );
    expect(state).toEqual({ status: 'ok', message: 'Added 5100 Office supplies.' });
  });

  it('shows a duplicate code under Code', async () => {
    api.createExpenseAccount.mockRejectedValue(
      new ApiError(409, 'conflict', errorBody('conflict', 'Code 5100 exists.')),
    );
    const state = await createExpenseAccountAction(
      IDLE,
      form({ code: '5100', name: 'Office supplies' }),
    );

    expect(state.status).toBe('error');
    expect(state.fieldErrors).toEqual({ code: DUPLICATE_CODE_MESSAGE });
    expect(state.fields).toEqual({ code: '5100', name: 'Office supplies' });
  });

  it('renames, retires and reactivates by id', async () => {
    api.renameExpenseAccount.mockResolvedValue({ id: ID, code: '5100', name: 'Stationery' });
    api.retireExpenseAccount.mockResolvedValue({ id: ID, code: '5100', name: 'Stationery' });
    api.reactivateExpenseAccount.mockResolvedValue({ id: ID, code: '5100', name: 'Stationery' });

    expect(
      (await renameExpenseAccountAction(IDLE, form({ id: ID, name: 'Stationery' }))).status,
    ).toBe('ok');
    expect(api.renameExpenseAccount).toHaveBeenCalledWith(
      session,
      ID,
      { name: 'Stationery' },
      expect.stringMatching(UUID),
    );
    expect((await changeExpenseAccountStatusAction(ID, 'retire')).message).toBe(
      'Retired 5100 Stationery.',
    );
    expect((await changeExpenseAccountStatusAction(ID, 'reactivate')).message).toBe(
      'Reactivated 5100 Stationery.',
    );
  });

  it('reports a failed retire as a sentence', async () => {
    api.retireExpenseAccount.mockRejectedValue(new ApiError(403, 'forbidden'));
    expect(await changeExpenseAccountStatusAction(ID, 'retire')).toEqual({
      status: 'error',
      message: "You don't have permission to retire expense accounts.",
    });
  });
});

describe('the Idempotency-Key a form submits', () => {
  const KEY = '33333333-3333-4333-8333-333333333333';

  it('is passed to the API as sent, so a double submit or a retry writes once', async () => {
    api.createExpenseAccount.mockResolvedValue({ id: ID, code: '5100', name: 'Office' });
    await createExpenseAccountAction(
      IDLE,
      form({ code: '5100', name: 'Office', idempotencyKey: KEY }),
    );
    await createExpenseAccountAction(
      IDLE,
      form({ code: '5100', name: 'Office', idempotencyKey: KEY }),
    );
    expect(api.createExpenseAccount.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      KEY,
      KEY,
    ]);

    api.renameCompanyBankAccount.mockResolvedValue({ id: ID, name: 'Payroll' });
    await renameBankAccountAction(IDLE, form({ id: ID, name: 'Payroll', idempotencyKey: KEY }));
    expect(api.renameCompanyBankAccount.mock.calls[0]?.[3]).toBe(KEY);

    api.retireCompanyBankAccount.mockResolvedValue({ id: ID, name: 'Operating' });
    await changeBankAccountStatusAction(ID, 'retire', KEY);
    expect(api.retireCompanyBankAccount.mock.calls[0]?.[2]).toBe(KEY);
  });

  it('is replaced by a fresh one when the form sent none or a malformed one', async () => {
    api.createCompanyBankAccount.mockResolvedValue({ id: ID, name: 'Operating account' });
    const fields = { name: 'Operating account', bankName: 'Nabil', last4: '4821', currency: 'NPR' };
    await createBankAccountAction(IDLE, form(fields));
    await createBankAccountAction(IDLE, form({ ...fields, idempotencyKey: "x'; DROP" }));
    for (const call of api.createCompanyBankAccount.mock.calls as unknown[][]) {
      expect(call[2] as string).toMatch(UUID);
    }
  });
});
