// Contracts for the paying entity's own bank accounts and its expense accounts (round 5, unit P1). Both are
// lists an entity keeps in Settings > Finance and picks from on bills and payment requests, instead of typing
// a GUID. A row is retired, never deleted: documents that name it keep working and keep showing its label.
// Only the last four characters of a bank account number are stored; the full number never reaches Business OS.
import { z } from 'zod';

import { CurrencySchema } from './money.js';

const text = (max: number) => z.string().trim().min(1).max(max);

export const COMPANY_ACCOUNT_STATUSES = ['active', 'retired'] as const;
export const CompanyAccountStatusSchema = z.enum(COMPANY_ACCOUNT_STATUSES);
export type CompanyAccountStatus = z.infer<typeof CompanyAccountStatusSchema>;

/** The label shown for an id that matches no row of the entity (an arbitrary GUID saved before these lists existed). */
export const UNKNOWN_ACCOUNT_LABEL = 'Unknown account';

// ---------------------------------------------------------------------------------------------
// Company bank accounts (where payments leave from)
// ---------------------------------------------------------------------------------------------

export const CompanyBankAccountSchema = z.object({
  id: z.guid(),
  /** What the entity calls it, for example "Operating account". */
  name: z.string(),
  bankName: z.string(),
  /** The last four characters of the account number. Never the full number. */
  last4: z.string(),
  currency: CurrencySchema,
  status: CompanyAccountStatusSchema,
  retiredAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CompanyBankAccount = z.infer<typeof CompanyBankAccountSchema>;

/** Currency, bank and last four are fixed once created (a payment request snapshots them by id); rename `name` only. */
export const CreateCompanyBankAccountBodySchema = z.strictObject({
  name: text(120),
  bankName: text(120),
  last4: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4}$/, 'enter the last four characters of the account number'),
  currency: CurrencySchema,
});
export type CreateCompanyBankAccountBody = z.infer<typeof CreateCompanyBankAccountBodySchema>;

export const RenameCompanyBankAccountBodySchema = z.strictObject({ name: text(120) });
export type RenameCompanyBankAccountBody = z.infer<typeof RenameCompanyBankAccountBodySchema>;

/** The picker label: "Nabil Bank ····1234 · NPR". `name` leads when it adds something to the bank name. */
export function companyBankAccountLabel(
  a: Pick<CompanyBankAccount, 'name' | 'bankName' | 'last4' | 'currency'>,
): string {
  return `${a.name} · ${a.bankName} ····${a.last4} · ${a.currency}`;
}

// ---------------------------------------------------------------------------------------------
// Expense accounts (what a bill line is booked to)
// ---------------------------------------------------------------------------------------------

export const ExpenseAccountSchema = z.object({
  id: z.guid(),
  code: z.string(),
  name: z.string(),
  status: CompanyAccountStatusSchema,
  retiredAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ExpenseAccount = z.infer<typeof ExpenseAccountSchema>;

/** The code is fixed once created (unique per entity); rename `name` only. */
export const CreateExpenseAccountBodySchema = z.strictObject({
  code: text(32),
  name: text(120),
});
export type CreateExpenseAccountBody = z.infer<typeof CreateExpenseAccountBodySchema>;

export const RenameExpenseAccountBodySchema = z.strictObject({ name: text(120) });
export type RenameExpenseAccountBody = z.infer<typeof RenameExpenseAccountBodySchema>;

export const expenseAccountLabel = (a: Pick<ExpenseAccount, 'code' | 'name'>): string =>
  `${a.code} · ${a.name}`;
