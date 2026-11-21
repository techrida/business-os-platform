import 'server-only';

import {
  CompanyBankAccountSchema,
  ExpenseAccountSchema,
  type CompanyBankAccount,
  type CreateCompanyBankAccountBody,
  type CreateExpenseAccountBody,
  type ExpenseAccount,
  type RenameCompanyBankAccountBody,
  type RenameExpenseAccountBody,
} from '@bos/contracts';
import { z } from 'zod';

import { call, jsonInit, seg } from './api-procurement';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the acting entity's own bank accounts
 * (`/v1/company-bank-accounts`) and expense accounts (`/v1/expense-accounts`). Server-only: every call
 * carries the user's access token. Responses are parsed with the contract schemas, so a drifted answer
 * fails here (502) instead of rendering `undefined`.
 *
 * Lists answer a bare array. Without options they hold active rows only, which is what a picker offers.
 * `{ includeRetired: true }` adds retired rows: the Settings list shows them, and a form needs them to
 * label a saved value that was retired since. Any active staff user may read either form.
 *
 * Writes need `settings.finance.write` and take the Idempotency-Key as a required argument (the API
 * answers 400 without one), so a missing key is a compile error. Rows are retired, never deleted.
 */

const BANK_PATH = '/v1/company-bank-accounts';
const EXPENSE_PATH = '/v1/expense-accounts';

export interface ListCompanyAccountsOptions {
  /** True to include retired rows as well as active ones. */
  includeRetired?: boolean;
}

const listPath = (path: string, options?: ListCompanyAccountsOptions): string =>
  options?.includeRetired === true ? `${path}?includeRetired=true` : path;

/** A body-less command (retire, reactivate): only the idempotency key travels. */
const command = (key: string): RequestInit => ({
  method: 'POST',
  headers: { 'idempotency-key': key },
});

// ---------------------------------------------------------------------------------------------
// Company bank accounts
// ---------------------------------------------------------------------------------------------

/** `GET /v1/company-bank-accounts`: active rows, or every row with `includeRetired`. */
export function listCompanyBankAccounts(
  session: Session,
  options?: ListCompanyAccountsOptions,
): Promise<CompanyBankAccount[]> {
  return call(session, listPath(BANK_PATH, options), z.array(CompanyBankAccountSchema));
}

/** `POST /v1/company-bank-accounts`: the new active row. */
export function createCompanyBankAccount(
  session: Session,
  body: CreateCompanyBankAccountBody,
  idempotencyKey: string,
): Promise<CompanyBankAccount> {
  return call(session, BANK_PATH, CompanyBankAccountSchema, jsonInit('POST', body, idempotencyKey));
}

/** `PATCH /v1/company-bank-accounts/:id`: changes the name only; bank, last four and currency are fixed. */
export function renameCompanyBankAccount(
  session: Session,
  id: string,
  body: RenameCompanyBankAccountBody,
  idempotencyKey: string,
): Promise<CompanyBankAccount> {
  return call(
    session,
    `${BANK_PATH}/${seg(id)}`,
    CompanyBankAccountSchema,
    jsonInit('PATCH', body, idempotencyKey),
  );
}

/** `POST /v1/company-bank-accounts/:id/retire`: no longer offered on new payment requests. */
export function retireCompanyBankAccount(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<CompanyBankAccount> {
  return call(
    session,
    `${BANK_PATH}/${seg(id)}/retire`,
    CompanyBankAccountSchema,
    command(idempotencyKey),
  );
}

/** `POST /v1/company-bank-accounts/:id/reactivate`: offered again. */
export function reactivateCompanyBankAccount(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<CompanyBankAccount> {
  return call(
    session,
    `${BANK_PATH}/${seg(id)}/reactivate`,
    CompanyBankAccountSchema,
    command(idempotencyKey),
  );
}

// ---------------------------------------------------------------------------------------------
// Expense accounts
// ---------------------------------------------------------------------------------------------

/** `GET /v1/expense-accounts`: active rows, or every row with `includeRetired`. */
export function listExpenseAccounts(
  session: Session,
  options?: ListCompanyAccountsOptions,
): Promise<ExpenseAccount[]> {
  return call(session, listPath(EXPENSE_PATH, options), z.array(ExpenseAccountSchema));
}

/** `POST /v1/expense-accounts`: the new active row. The code is unique per entity. */
export function createExpenseAccount(
  session: Session,
  body: CreateExpenseAccountBody,
  idempotencyKey: string,
): Promise<ExpenseAccount> {
  return call(session, EXPENSE_PATH, ExpenseAccountSchema, jsonInit('POST', body, idempotencyKey));
}

/** `PATCH /v1/expense-accounts/:id`: changes the name only; the code is fixed. */
export function renameExpenseAccount(
  session: Session,
  id: string,
  body: RenameExpenseAccountBody,
  idempotencyKey: string,
): Promise<ExpenseAccount> {
  return call(
    session,
    `${EXPENSE_PATH}/${seg(id)}`,
    ExpenseAccountSchema,
    jsonInit('PATCH', body, idempotencyKey),
  );
}

/** `POST /v1/expense-accounts/:id/retire`: no longer offered on new bills. */
export function retireExpenseAccount(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<ExpenseAccount> {
  return call(
    session,
    `${EXPENSE_PATH}/${seg(id)}/retire`,
    ExpenseAccountSchema,
    command(idempotencyKey),
  );
}

/** `POST /v1/expense-accounts/:id/reactivate`: offered again. */
export function reactivateExpenseAccount(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<ExpenseAccount> {
  return call(
    session,
    `${EXPENSE_PATH}/${seg(id)}/reactivate`,
    ExpenseAccountSchema,
    command(idempotencyKey),
  );
}
