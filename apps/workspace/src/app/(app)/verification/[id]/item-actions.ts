'use server';
import { randomUUID } from 'node:crypto';
import {
  ReviewVerificationItemBodySchema,
  ChecklistItemKeySchema,
  VerificationVersionBodySchema,
} from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { requireStaffSession } from '@/lib/bff';
import { apiFetch } from '@/lib/api';
import { getVerificationCase } from '@/components/p2/customers/api';
import { failureOf } from '@/lib/api-kernel';
import { isGuid } from '@/components/p2/customers/format';
import { keyOf, nextKey } from '@/components/p2/crm/idempotency';
import {
  reviewVerificationItem,
  detachVerificationItem,
} from '@/components/p2/crm/verification-api';
export interface ItemState {
  key: string;
  error?: string;
  reload?: boolean;
  done?: boolean;
  errors?: { comment?: string };
}
function textOf(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}
export async function itemAction(_prev: ItemState, form: FormData): Promise<ItemState> {
  const id = textOf(form, 'caseId');
  const key = keyOf(form);
  if (!isGuid(id)) return { key, error: 'Reload this case.', reload: true };
  const session = await requireStaffSession(`/verification/${id}`);
  const itemKey = ChecklistItemKeySchema.safeParse(form.get('itemKey'));
  const intent = form.get('intent');
  const version = Number(form.get('expectedVersion'));
  if (!itemKey.success) return { key, error: 'Reload this case.', reload: true };
  try {
    if (intent === 'detach') {
      const body = VerificationVersionBodySchema.parse({ expectedVersion: version });
      await detachVerificationItem(session, id, itemKey.data, body.expectedVersion, key);
    } else {
      const body = ReviewVerificationItemBodySchema.safeParse({
        decision: intent,
        expectedVersion: version,
        ...(intent === 'reject' ? { comment: form.get('comment') } : {}),
      });
      if (!body.success)
        return { key, errors: { comment: 'Enter a reason of 1 to 2000 characters.' } };
      await reviewVerificationItem(session, id, itemKey.data, body.data, key);
    }
  } catch (error) {
    const failure = failureOf(error);
    return {
      key: nextKey(error, key),
      error: failure.message,
      ...(failure.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/verification');
  revalidatePath(`/verification/${id}`);
  revalidatePath('/customers');
  return { key: randomUUID(), done: true };
}

export async function removeLooseAction(prev: ItemState, form: FormData): Promise<ItemState> {
  const id = textOf(form, 'caseId'),
    documentId = textOf(form, 'documentId');
  if (!isGuid(id) || !isGuid(documentId))
    return { ...prev, error: 'Reload this case.', reload: true };
  const session = await requireStaffSession(`/verification/${id}`);
  try {
    const c = await getVerificationCase(session, id);
    if (
      !['draft', 'rejected'].includes(c.status) ||
      !c.looseEvidence?.some((v) => v.documentId === documentId)
    )
      return { ...prev, error: 'This attachment is unavailable. Reload this case.', reload: true };
    const response = await apiFetch(session, `/v1/documents/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
    });
    if (!response.ok)
      return {
        ...prev,
        error: 'The file could not be removed. Reload and try again.',
        reload: true,
      };
  } catch (error) {
    return { ...prev, error: failureOf(error).message };
  }
  revalidatePath(`/verification/${id}`);
  return { ...prev, done: true };
}
