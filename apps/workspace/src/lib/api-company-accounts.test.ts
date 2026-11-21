import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from './api';
import {
  createCompanyBankAccount,
  createExpenseAccount,
  listCompanyBankAccounts,
  listExpenseAccounts,
  reactivateCompanyBankAccount,
  reactivateExpenseAccount,
  renameCompanyBankAccount,
  renameExpenseAccount,
  retireCompanyBankAccount,
  retireExpenseAccount,
} from './api-company-accounts';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  apiFetch: vi.fn(),
}));

const id = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const session = { roles: ['finance'] } as Session;

const bank = {
  id,
  name: 'Operating account',
  bankName: 'Nabil Bank',
  last4: '1234',
  currency: 'NPR',
  status: 'active',
  retiredAt: null,
};
const retiredBank = { ...bank, status: 'retired', retiredAt: '2026-11-20T09:30:00.000Z' };
const expense = { id, code: '5100', name: 'Office supplies', status: 'active', retiredAt: null };
const retiredExpense = { ...expense, status: 'retired', retiredAt: '2026-11-20T09:30:00+05:45' };

const reply = (body: unknown, status = 200) =>
  vi
    .mocked(apiFetch)
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

beforeEach(() => vi.clearAllMocks());

describe('company bank accounts client', () => {
  it('lists active rows from the bare route', async () => {
    reply([bank]);
    expect(await listCompanyBankAccounts(session)).toEqual([bank]);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
      session,
      '/v1/company-bank-accounts',
      undefined,
    );
  });

  it('asks for retired rows too only when told to', async () => {
    reply([bank, retiredBank]);
    expect(await listCompanyBankAccounts(session, { includeRetired: true })).toEqual([
      bank,
      retiredBank,
    ]);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
      session,
      '/v1/company-bank-accounts?includeRetired=true',
      undefined,
    );
    reply([bank]);
    await listCompanyBankAccounts(session, { includeRetired: false });
    expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/company-bank-accounts', undefined);
  });

  it.each([
    { ...bank, id: 'not-a-guid' },
    { ...bank, last4: undefined },
    { ...bank, currency: 'XYZ' },
    { ...bank, status: 'deleted' },
    { ...bank, retiredAt: 'yesterday' },
  ])('refuses a list row that drifts from the contract: %j', async (invalid) => {
    reply([invalid]);
    await expect(listCompanyBankAccounts(session)).rejects.toMatchObject({ status: 502 });
  });

  it('passes an API refusal through with its status', async () => {
    reply({ code: 'FORBIDDEN' }, 403);
    await expect(
      createCompanyBankAccount(
        session,
        { name: 'Operating account', bankName: 'Nabil Bank', last4: '1234', currency: 'NPR' },
        key,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('creates with the idempotency key and sends only the supplied body', async () => {
    reply(bank, 201);
    const body = {
      name: 'Operating account',
      bankName: 'Nabil Bank',
      last4: '1234',
      currency: 'NPR' as const,
    };
    expect(await createCompanyBankAccount(session, body, key)).toEqual(bank);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(session, '/v1/company-bank-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
  });

  it('renames with PATCH on the encoded id', async () => {
    reply({ ...bank, name: 'Payroll' });
    await renameCompanyBankAccount(session, '../x', { name: 'Payroll' }, key);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(session, '/v1/company-bank-accounts/..%2Fx', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ name: 'Payroll' }),
    });
  });

  it('retires and reactivates with a body-less keyed POST', async () => {
    reply(retiredBank);
    expect(await retireCompanyBankAccount(session, id, key)).toEqual(retiredBank);
    expect(apiFetch).toHaveBeenLastCalledWith(session, `/v1/company-bank-accounts/${id}/retire`, {
      method: 'POST',
      headers: { 'idempotency-key': key },
    });
    reply(bank);
    expect(await reactivateCompanyBankAccount(session, id, key)).toEqual(bank);
    expect(apiFetch).toHaveBeenLastCalledWith(
      session,
      `/v1/company-bank-accounts/${id}/reactivate`,
      { method: 'POST', headers: { 'idempotency-key': key } },
    );
  });
});

describe('expense accounts client', () => {
  it('lists active rows, and retired rows too only when told to', async () => {
    reply([expense]);
    expect(await listExpenseAccounts(session)).toEqual([expense]);
    expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/expense-accounts', undefined);
    reply([expense, retiredExpense]);
    expect(await listExpenseAccounts(session, { includeRetired: true })).toEqual([
      expense,
      retiredExpense,
    ]);
    expect(apiFetch).toHaveBeenLastCalledWith(
      session,
      '/v1/expense-accounts?includeRetired=true',
      undefined,
    );
  });

  it.each([
    { ...expense, code: undefined },
    { ...expense, id: 'x' },
    { ...expense, status: 'gone' },
  ])('refuses a list row that drifts from the contract: %j', async (invalid) => {
    reply([invalid]);
    await expect(listExpenseAccounts(session)).rejects.toMatchObject({ status: 502 });
  });

  it('creates and renames with the idempotency key', async () => {
    reply(expense, 201);
    await createExpenseAccount(session, { code: '5100', name: 'Office supplies' }, key);
    expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/expense-accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ code: '5100', name: 'Office supplies' }),
    });
    reply({ ...expense, name: 'Stationery' });
    await renameExpenseAccount(session, id, { name: 'Stationery' }, key);
    expect(apiFetch).toHaveBeenLastCalledWith(session, `/v1/expense-accounts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ name: 'Stationery' }),
    });
  });

  it('retires and reactivates with a body-less keyed POST', async () => {
    reply(retiredExpense);
    expect(await retireExpenseAccount(session, id, key)).toEqual(retiredExpense);
    expect(apiFetch).toHaveBeenLastCalledWith(session, `/v1/expense-accounts/${id}/retire`, {
      method: 'POST',
      headers: { 'idempotency-key': key },
    });
    reply(expense);
    await reactivateExpenseAccount(session, id, key);
    expect(apiFetch).toHaveBeenLastCalledWith(session, `/v1/expense-accounts/${id}/reactivate`, {
      method: 'POST',
      headers: { 'idempotency-key': key },
    });
  });

  it('refuses a write answer that drifts from the contract', async () => {
    reply({ ...expense, status: 'archived' });
    await expect(retireExpenseAccount(session, id, key)).rejects.toMatchObject({ status: 502 });
  });
});
