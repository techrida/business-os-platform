'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { echo, UUID } from '@/components/p2/crm/action-helpers';
import { createActivity } from '@/components/p2/crm/crm-api';
import { parseActivity } from '@/components/p2/crm/forms';
import { keyOf, nextKey } from '@/components/p2/crm/idempotency';
import type { FormState } from '@/components/p2/crm/types';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

const PAGE: Record<string, string> = { leadId: '/leads', opportunityId: '/opportunities' };

/**
 * Log a call, meeting, email or note on a lead or an opportunity. `task` and a note with a due time
 * are refused by the parser (D39), so nothing reaches the API.
 */
export async function logActivityAction(_prev: FormState, form: FormData): Promise<FormState> {
  const kind = form.get('subjectKind');
  const id = form.get('subjectId');
  const base = typeof kind === 'string' ? PAGE[kind] : undefined;
  const values = echo(form);
  const key = keyOf(form);
  if (base === undefined || typeof id !== 'string' || !UUID.test(id)) {
    return { values, fieldErrors: {}, error: 'This form is incomplete. Reload the page.', key };
  }
  const session = await requireStaffSession(`${base}/${id}`);

  const parsed = parseActivity(form);
  if (!parsed.ok) {
    const { form: formError, ...fieldErrors } = parsed.fieldErrors;
    return { values, fieldErrors, ...(formError ? { error: formError } : {}), key };
  }
  try {
    await createActivity(session, parsed.data, key);
  } catch (err) {
    return { values, fieldErrors: {}, error: failureOf(err).message, key: nextKey(err, key) };
  }
  revalidatePath(`${base}/${id}`);
  revalidatePath('/activities');
  // The form stays on the page and clears, so the next activity is a new request with a new key.
  return { values: {}, fieldErrors: {}, ok: true, key: randomUUID() };
}
