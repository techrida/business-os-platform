import 'server-only';

import type { RecordKind } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

import { changeLeadStage, changeOpportunityStage } from './crm-api';
import { parseStageMove } from './forms';
import { stageLabel } from './stages';
import type { MoveState } from './types';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{8,64}$/;

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
    const f = failureOf(err);
    return { error: f.message, reload: f.reload };
  }
  revalidatePath(base);
  revalidatePath(`${base}/${id}`);
  return { ok: true, movedTo: stageLabel(kind, parsed.data.stage) };
}
