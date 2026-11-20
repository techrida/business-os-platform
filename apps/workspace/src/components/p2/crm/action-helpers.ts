import 'server-only';

import { ASSIGNMENT_DENY_MESSAGES, type RecordKind } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { ApiError } from '@/lib/api';
import { apiDetailOf } from '@/lib/api-code';
import { apiMessageOf, failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

import { changeLeadStage, changeOpportunityStage } from './crm-api';
import { parseStageMove } from './forms';
import { stageLabel } from './stages';
import type { MoveState } from './types';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Why the assignment rule (D38/D50) refused a new owner, in product words, from the code the API
 * sends as `details.assignmentReason`. Undefined for any other answer, or a code this build does
 * not know, so the caller falls back to its generic wording.
 */
export function assignmentRefusalText(err: unknown): string | undefined {
  const reason = apiDetailOf(err, 'assignmentReason');
  if (typeof reason !== 'string' || !Object.hasOwn(ASSIGNMENT_DENY_MESSAGES, reason))
    return undefined;
  return `The new owner ${ASSIGNMENT_DENY_MESSAGES[reason as keyof typeof ASSIGNMENT_DENY_MESSAGES]}.`;
}

/** The API's 409 text when a new lost reason's words are already on the tenant's list. */
const DUPLICATE_LOST_REASON = /already on the list of lost reasons/;
const DUPLICATE_LOST_REASON_TEXT =
  'That reason already exists, or was retired. Use different words, or ask a Founder to restore it.';

/** Every string field of a form, so a refusal can show back what was typed. */
export function echo(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * The shared body of the lead and opportunity stage actions: check the id, the session and the
 * form, call the API, and say what happened in words. `won`, `quotation_sent` and `converted` are
 * refused by the parser even if a browser sends them.
 */
export async function runStageMove(
  kind: RecordKind,
  form: FormData,
  base: '/leads' | '/opportunities',
): Promise<MoveState> {
  const idValue = form.get('recordId');
  const id = typeof idValue === 'string' ? idValue : '';
  if (!UUID.test(id)) return { error: 'This form is incomplete. Reload the page.', reload: true };
  const session = await requireStaffSession(`${base}/${id}`);

  const parsed = parseStageMove(kind, form);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  try {
    if (kind === 'lead') {
      await changeLeadStage(session, id, parsed.data as Parameters<typeof changeLeadStage>[2]);
    } else {
      await changeOpportunityStage(
        session,
        id,
        parsed.data as Parameters<typeof changeOpportunityStage>[2],
      );
    }
  } catch (err) {
    // Two different 409s reach here: the record changed under the form (reload), or the new lost
    // reason's words are already on the list. `failureOf` words both the same, so tell them apart by the API's text.
    if (
      err instanceof ApiError &&
      err.status === 409 &&
      DUPLICATE_LOST_REASON.test(apiMessageOf(err) ?? '')
    ) {
      return { fieldErrors: { newLostReason: DUPLICATE_LOST_REASON_TEXT } };
    }
    const f = failureOf(err);
    return { error: f.message, reload: f.reload };
  }
  revalidatePath(base);
  revalidatePath(`${base}/${id}`);
  if (
    kind === 'lead' &&
    parsed.data.stage === 'contacted' &&
    'contactActivity' in parsed.data &&
    parsed.data.contactActivity !== undefined
  ) {
    revalidatePath('/activities');
  }
  return { ok: true, movedTo: stageLabel(kind, parsed.data.stage) };
}
