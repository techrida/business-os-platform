'use server';

import {
  CreateCompanyBankAccountBodySchema,
  CreateExpenseAccountBodySchema,
  ErrorBodySchema,
  RenameCompanyBankAccountBodySchema,
  RenameExpenseAccountBodySchema,
} from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  createCompanyBankAccount,
  createExpenseAccount,
  reactivateCompanyBankAccount,
  reactivateExpenseAccount,
  renameCompanyBankAccount,
  renameExpenseAccount,
  retireCompanyBankAccount,
  retireExpenseAccount,
} from '@/lib/api-company-accounts';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';
import { DUPLICATE_CODE_MESSAGE } from './copy';
import { keyOf } from './idempotency';

// Server Actions for Settings > Finance > Bank and expense accounts. The section permission
// (settings.finance.write, or admin.settings.write) is re-checked on every action because each one is
// its own request, apart from the page that rendered the form. Rows are retired, never deleted.

const PATH = '/settings/company-accounts';

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** Plain messages per field, replacing the schema's own wording. */
const FIELD_MESSAGES: Record<string, { empty: string; invalid: string }> = {
  name: { empty: 'Enter a name.', invalid: 'Keep the name to 120 characters or fewer.' },
  bankName: {
    empty: 'Enter the bank name.',
    invalid: 'Keep the bank name to 120 characters or fewer.',
  },
  last4: {
    empty: 'Enter the last four characters of the account number.',
    invalid: 'Enter exactly four letters or digits, for example 4821.',
  },
  currency: { empty: 'Choose a currency.', invalid: 'Choose a currency.' },
  code: { empty: 'Enter a code.', invalid: 'Keep the code to 32 characters or fewer.' },
};

function invalid(issues: z.ZodError['issues'], fields: Record<string, string>): ActionState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    if (key === '' || fieldErrors[key]) continue;
    const words = FIELD_MESSAGES[key];
    fieldErrors[key] = words ? (fields[key] ? words.invalid : words.empty) : 'Check this field.';
  }
  return {
    ...fail(Object.values(fieldErrors).join('\n') || 'Check the form and try again.', fields),
    fieldErrors,
  };
}

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return typeof error.status === 'number' ? error.status : null;
  }
  return null;
}

/**
 * A refused write as form state. A 409 on a field that must be unique becomes that field's message;
 * a 422 whose details name submitted fields puts each message under its field; anything else is one
 * sentence (403 names what the user may not do).
 */
function refused(
  error: unknown,
  action: string,
  fields: Record<string, string>,
  uniqueField?: { name: string; message: string },
): ActionState {
  const status = statusOf(error);
  if (status === 409 && uniqueField) {
    return {
      ...fail(uniqueField.message, fields),
      fieldErrors: { [uniqueField.name]: uniqueField.message },
    };
  }
  const message = describeError(error, action);
  if (status === 422 && typeof error === 'object' && error !== null && 'body' in error) {
    const body = ErrorBodySchema.safeParse(error.body);
    const fieldErrors: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      body.success ? (body.data.error.details ?? {}) : {},
    )) {
      if (key in fields && typeof value === 'string' && value.trim() !== '') {
        fieldErrors[key] = value;
      }
    }
    if (Object.keys(fieldErrors).length > 0) return { ...fail(message, fields), fieldErrors };
  }
  return fail(message, fields);
}

const Id = z.guid();

// ---------------------------------------------------------------------------------------------
// Company bank accounts
// ---------------------------------------------------------------------------------------------

export async function createBankAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('company-accounts');
  const fields = {
    name: text(formData, 'name'),
    bankName: text(formData, 'bankName'),
    last4: text(formData, 'last4'),
    currency: text(formData, 'currency'),
  };
  const parsed = CreateCompanyBankAccountBodySchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error.issues, fields);

  try {
    await createCompanyBankAccount(session, parsed.data, keyOf(formData.get('idempotencyKey')));
  } catch (error) {
    return refused(error, 'add bank accounts', fields);
  }
  revalidatePath(PATH);
  return ok(`Added ${parsed.data.name}.`);
}

export async function renameBankAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('company-accounts');
  const id = Id.safeParse(text(formData, 'id'));
  const fields = { name: text(formData, 'name') };
  if (!id.success) return fail('That bank account could not be found. Reload the page.', fields);
  const parsed = RenameCompanyBankAccountBodySchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error.issues, fields);

  try {
    await renameCompanyBankAccount(
      session,
      id.data,
      parsed.data,
      keyOf(formData.get('idempotencyKey')),
    );
  } catch (error) {
    return refused(error, 'rename bank accounts', fields);
  }
  revalidatePath(PATH);
  return ok(`Renamed to ${parsed.data.name}.`);
}

export type StatusChange = 'retire' | 'reactivate';

export async function changeBankAccountStatusAction(
  id: string,
  change: StatusChange,
  idempotencyKey?: string,
): Promise<ActionState> {
  const session = await requireSection('company-accounts');
  const parsed = Id.safeParse(id);
  if (!parsed.success) return fail('That bank account could not be found. Reload the page.');
  try {
    const row =
      change === 'retire'
        ? await retireCompanyBankAccount(session, parsed.data, keyOf(idempotencyKey))
        : await reactivateCompanyBankAccount(session, parsed.data, keyOf(idempotencyKey));
    revalidatePath(PATH);
    return ok(change === 'retire' ? `Retired ${row.name}.` : `Reactivated ${row.name}.`);
  } catch (error) {
    return fail(describeError(error, `${change} bank accounts`));
  }
}

// ---------------------------------------------------------------------------------------------
// Expense accounts
// ---------------------------------------------------------------------------------------------

export async function createExpenseAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('company-accounts');
  const fields = { code: text(formData, 'code'), name: text(formData, 'name') };
  const parsed = CreateExpenseAccountBodySchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error.issues, fields);

  try {
    await createExpenseAccount(session, parsed.data, keyOf(formData.get('idempotencyKey')));
  } catch (error) {
    return refused(error, 'add expense accounts', fields, {
      name: 'code',
      message: DUPLICATE_CODE_MESSAGE,
    });
  }
  revalidatePath(PATH);
  return ok(`Added ${parsed.data.code} ${parsed.data.name}.`);
}

export async function renameExpenseAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('company-accounts');
  const id = Id.safeParse(text(formData, 'id'));
  const fields = { name: text(formData, 'name') };
  if (!id.success) return fail('That expense account could not be found. Reload the page.', fields);
  const parsed = RenameExpenseAccountBodySchema.safeParse(fields);
  if (!parsed.success) return invalid(parsed.error.issues, fields);

  try {
    await renameExpenseAccount(
      session,
      id.data,
      parsed.data,
      keyOf(formData.get('idempotencyKey')),
    );
  } catch (error) {
    return refused(error, 'rename expense accounts', fields);
  }
  revalidatePath(PATH);
  return ok(`Renamed to ${parsed.data.name}.`);
}

export async function changeExpenseAccountStatusAction(
  id: string,
  change: StatusChange,
  idempotencyKey?: string,
): Promise<ActionState> {
  const session = await requireSection('company-accounts');
  const parsed = Id.safeParse(id);
  if (!parsed.success) return fail('That expense account could not be found. Reload the page.');
  try {
    const row =
      change === 'retire'
        ? await retireExpenseAccount(session, parsed.data, keyOf(idempotencyKey))
        : await reactivateExpenseAccount(session, parsed.data, keyOf(idempotencyKey));
    revalidatePath(PATH);
    return ok(
      change === 'retire'
        ? `Retired ${row.code} ${row.name}.`
        : `Reactivated ${row.code} ${row.name}.`,
    );
  } catch (error) {
    return fail(describeError(error, `${change} expense accounts`));
  }
}
