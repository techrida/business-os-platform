'use server';

import { AccessChangeSchema, AccessWarningCodeSchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  mapAccessPreviewError,
  mapAccessSaveError,
  previewAccessChanges,
  saveAccessChanges,
} from '@/lib/api-access';

import type { PreviewActionResult, SaveActionResult } from './_lib/action-types';
import { requireAccess } from './_lib/guard';

// Server Actions behind the By role page's review dialog. The browser never sees the access token:
// each action runs with the session and calls the API itself. Each re-checks access because it is
// its own request. Arguments come from the browser, so they are parsed before use.

const RETURN_TO = '/settings/access/roles';

const ChangesSchema = z.array(AccessChangeSchema).min(1).max(200);

const SaveInputSchema = z.object({
  changes: ChangesSchema,
  expectedRevision: z.string().min(1),
  acknowledged: z.array(AccessWarningCodeSchema).max(20),
  note: z.string().trim().max(280),
});

const INVALID_REQUEST = 'These changes could not be read. Reload the page and try again.';
const WRITE_DENIED = 'Only a Founder can change access.';

/** The dry run: what would change, who is affected, and the warnings. It never writes. */
export async function previewAccessAction(changes: unknown): Promise<PreviewActionResult> {
  const { session } = await requireAccess(RETURN_TO);
  const parsed = ChangesSchema.safeParse(changes);
  if (!parsed.success) return { ok: false, message: INVALID_REQUEST };
  try {
    return { ok: true, preview: await previewAccessChanges(session, { changes: parsed.data }) };
  } catch (error) {
    return { ok: false, message: mapAccessPreviewError(error) };
  }
}

/** Saves reviewed changes against the revision the page loaded; a newer save refuses it as stale. */
export async function saveAccessAction(input: unknown): Promise<SaveActionResult> {
  const { session, canWrite } = await requireAccess(RETURN_TO);
  if (!canWrite) return { ok: false, kind: 'error', message: WRITE_DENIED };
  const parsed = SaveInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, kind: 'invalid', message: INVALID_REQUEST };
  const { changes, expectedRevision, acknowledged, note } = parsed.data;
  try {
    await saveAccessChanges(session, {
      changes,
      expectedRevision,
      acknowledged,
      ...(note === '' ? {} : { note }),
    });
  } catch (error) {
    return { ok: false, ...mapAccessSaveError(error) };
  }
  // By area and By role read the same grants: refresh every Access tab.
  revalidatePath('/settings/access', 'layout');
  return { ok: true };
}
