'use server';

import { CreateMemoBodySchema, CURRENCIES } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createMemo, failureOf, submitMemo, updateMemo } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

/**
 * Server actions for the test memo: create, edit and submit. Every one validates
 * on the server (the browser's checks are a courtesy) and asks `requireStaffSession` first, so an
 * expired session goes to sign-in and comes back to the right page.
 */

export interface MemoValues {
  title: string;
  body: string;
  amount: string;
  currency: string;
  template?: string | undefined;
}

export interface MemoFormState {
  values: MemoValues;
  fieldErrors: Partial<Record<keyof MemoValues, string>>;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELD_MESSAGE: Record<keyof MemoValues, string> = {
  template: 'Check the department, date and staff selections.',
  title: 'Enter a title, up to 200 characters.',
  body: 'The body is too long. The limit is 10,000 characters.',
  amount: 'Enter an amount such as 1250.50: digits with at most two decimals, not negative.',
  currency: `Choose one of ${CURRENCIES.join(', ')}.`,
};

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

function readValues(form: FormData): MemoValues {
  return {
    title: text(form, 'title').trim(),
    body: text(form, 'body'),
    // People type 12,50,000.00 in Nepal; the contract wants plain digits, so drop grouping.
    amount: text(form, 'amount').replace(/[\s,]/g, ''),
    currency: text(form, 'currency'),
    template: text(form, 'template') || undefined,
  };
}

function validate(values: MemoValues) {
  let template: unknown;
  try {
    template = values.template ? JSON.parse(values.template) : undefined;
  } catch {
    return { ok: false as const, fieldErrors: {}, error: 'Invalid memo fields' };
  }
  const parsed = CreateMemoBodySchema.safeParse({ ...values, template });
  if (parsed.success) return { ok: true as const, data: parsed.data };
  const fieldErrors: MemoFormState['fieldErrors'] = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && key in FIELD_MESSAGE) {
      const k = key as keyof MemoValues;
      fieldErrors[k] ??= FIELD_MESSAGE[k];
    }
  }
  return { ok: false as const, fieldErrors };
}

export async function createMemoAction(
  _prev: MemoFormState,
  form: FormData,
): Promise<MemoFormState> {
  const session = await requireStaffSession('/memos/new');
  const values = readValues(form);
  const checked = validate(values);
  if (!checked.ok)
    return {
      values,
      fieldErrors: checked.fieldErrors,
      error: 'Check all memo fields and choose different people for each role.',
    };

  let id: string;
  try {
    id = (await createMemo(session, checked.data)).id;
  } catch (err) {
    return { values, fieldErrors: {}, error: failureOf(err).message };
  }
  revalidatePath('/memos');
  // "Save and add attachments": the memo must exist before a file can be attached to it, so save first
  // and land on the upload step. `attach=1` shows the banner, `#attachments` scrolls to the panel.
  redirect(
    text(form, 'intent') === 'attach' ? `/memos/${id}?attach=1#attachments` : `/memos/${id}`,
  );
}

export async function updateMemoAction(
  _prev: MemoFormState,
  form: FormData,
): Promise<MemoFormState> {
  const memoId = text(form, 'memoId');
  const values = readValues(form);
  if (!UUID.test(memoId)) {
    return { values, fieldErrors: {}, error: 'This form is incomplete. Reload the page.' };
  }
  const session = await requireStaffSession(`/memos/${memoId}`);
  const checked = validate(values);
  if (!checked.ok)
    return {
      values,
      fieldErrors: checked.fieldErrors,
      error: 'Check all memo fields and choose different people for each role.',
    };

  try {
    await updateMemo(session, memoId, checked.data);
  } catch (err) {
    const f = failureOf(err);
    return {
      values,
      fieldErrors: {},
      error:
        f.status === 409
          ? 'This memo can only be edited while it is a draft or returned. Reload to see where it stands.'
          : f.message,
    };
  }
  revalidatePath(`/memos/${memoId}`);
  redirect(`/memos/${memoId}?saved=1`);
}

export interface SubmitState {
  error?: string;
}

export async function submitMemoAction(_prev: SubmitState, form: FormData): Promise<SubmitState> {
  const memoId = text(form, 'memoId');
  if (!UUID.test(memoId)) return { error: 'This form is incomplete. Reload the page.' };
  const session = await requireStaffSession(`/memos/${memoId}`);

  let status: 'pending' | 'blocked';
  try {
    status = (await submitMemo(session, memoId)).status;
  } catch (err) {
    return { error: failureOf(err, 'submit').message };
  }
  revalidatePath(`/memos/${memoId}`);
  redirect(`/memos/${memoId}?submitted=${status}`);
}
