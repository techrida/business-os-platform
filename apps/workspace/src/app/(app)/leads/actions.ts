'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ApiError } from '@/lib/api';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

import { echo, IDEMPOTENCY_KEY, runStageMove, UUID } from '@/components/p2/crm/action-helpers';
import { convertLead, createLead } from '@/components/p2/crm/crm-api';
import { listContacts } from '@/components/p2/customers/api';
import type { ContactChoices } from '@/components/p2/crm/convert-dialog';
import { duplicatesFrom } from '@/components/p2/crm/duplicates';
import { parseConvert, parseLead } from '@/components/p2/crm/forms';
import { keyOf, nextKey } from '@/components/p2/crm/idempotency';
import type { ConvertState, FormState, MoveState } from '@/components/p2/crm/types';

/**
 * Server actions for leads. Each asks `requireStaffSession` first, so an expired session goes to
 * sign-in and comes back; each validates on the server (the browser's checks are a courtesy).
 */

export async function moveLeadStageAction(_prev: MoveState, form: FormData): Promise<MoveState> {
  return runStageMove('lead', form, '/leads');
}

export async function createLeadAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireStaffSession('/leads/new');
  const values = echo(form);
  const key = keyOf(form);
  const parsed = parseLead(form);
  if (!parsed.ok) return { values, fieldErrors: parsed.fieldErrors, key };

  let id: string;
  try {
    id = (await createLead(session, parsed.data, key)).id;
  } catch (err) {
    return { values, fieldErrors: {}, error: failureOf(err).message, key: nextKey(err, key) };
  }
  revalidatePath('/leads');
  redirect(`/leads/${id}`);
}

export async function convertLeadAction(
  _prev: ConvertState,
  form: FormData,
): Promise<ConvertState> {
  const idValue = form.get('leadId');
  const leadId = typeof idValue === 'string' ? idValue : '';
  const values = echo(form);
  if (!UUID.test(leadId)) {
    return {
      values,
      fieldErrors: {},
      error: 'This form is incomplete. Reload the page.',
      reload: true,
    };
  }
  const session = await requireStaffSession(`/leads/${leadId}`);

  const parsed = parseConvert(form);
  if (!parsed.ok) return { values, fieldErrors: parsed.fieldErrors };

  const keyValue = form.get('idempotencyKey');
  const key =
    typeof keyValue === 'string' && IDEMPOTENCY_KEY.test(keyValue) ? keyValue : randomUUID();

  let opportunityId: string;
  try {
    opportunityId = (await convertLead(session, leadId, parsed.data, key)).opportunityId;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const duplicates = duplicatesFrom(err.body);
      if (duplicates !== null) return { values, fieldErrors: {}, duplicates, definite: true };
    }
    const f = failureOf(err);
    return { values, fieldErrors: {}, error: f.message, definite: f.definite, reload: f.reload };
  }
  revalidatePath('/leads');
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/opportunities');
  redirect(`/opportunities/${opportunityId}`);
}

/** The existing API read enforces customer.read and customer visibility for this session. */
export async function loadConvertContacts(customerId: string): Promise<ContactChoices> {
  const session = await requireStaffSession('/leads');
  if (!UUID.test(customerId)) return { contacts: [], error: 'Select a customer first.' };
  try {
    const result = await listContacts(session, customerId);
    return {
      contacts: result.items.map((contact) => ({ id: contact.id, name: contact.fullName })),
    };
  } catch (err) {
    return { contacts: [], error: failureOf(err).message };
  }
}
