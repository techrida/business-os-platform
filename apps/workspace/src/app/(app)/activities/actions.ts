'use server';

import { revalidatePath } from 'next/cache';

import { echo, UUID } from '@/components/p2/crm/action-helpers';
import { createActivity } from '@/components/p2/crm/crm-api';
import { parseActivity } from '@/components/p2/crm/forms';
import type { FormState } from '@/components/p2/crm/types';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

const PAGE: Record<string, string> = { leadId: '/leads', opportunityId: '/opportunities' };

/** Log a call, meeting, email, note or task on a lead or an opportunity. */
export async function logActivityAction(_prev: FormState, form: FormData): Promise<FormState> {
  const kind = form.get('subjectKind');
  const id = form.get('subjectId');
  const base = typeof kind === 'string' ? PAGE[kind] : undefined;
  const values = echo(form);
  if (base === undefined || typeof id !== 'string' || !UUID.test(id)) {
    return { values, fieldErrors: {}, error: 'This form is incomplete. Reload the page.' };
  }
  const session = await requireStaffSession(`${base}/${id}`);

  const parsed = parseActivity(form);
  if (!parsed.ok) {
    const { form: formError, ...fieldErrors } = parsed.fieldErrors;
    return { values, fieldErrors, ...(formError ? { error: formError } : {}) };
  }
  try {
    await createActivity(session, parsed.data);
  } catch (err) {
    return { values, fieldErrors: {}, error: failureOf(err).message };
  }
  revalidatePath(`${base}/${id}`);
  revalidatePath('/activities');
  return { values: {}, fieldErrors: {}, ok: true };
}
