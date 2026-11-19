'use server';

import { AccessChangeSchema, AccessWarningCodeSchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import type {
  ReviewCheckResult,
  ReviewPreviewResult,
  ReviewSaveResult,
} from '@/components/access/review-changes-dialog';
import { permissionChecker } from '@/components/p2/customers/permissions';
import {
  mapAccessPreviewError,
  mapAccessSaveError,
  previewAccessChanges,
  saveAccessChanges,
} from '@/lib/api-access';

import { requireSection } from '../guard';

// Server Actions behind Access > By area and its review dialog. Each one is a public POST endpoint:
// it checks the section first (outside any try block, because `redirect` throws), parses its input,
// and only then calls the API, which still decides every request. Nothing here writes before the
// review dialog's Save changes (acceptance criterion 4.4): preview and check are dry runs.

const ChangesSchema = z.array(AccessChangeSchema).min(1).max(200);

const PreviewInputSchema = z.object({ changes: ChangesSchema });

const CheckInputSchema = z.object({ changes: ChangesSchema, person: z.guid() });

const SaveInputSchema = z.object({
  changes: ChangesSchema,
  expectedRevision: z.string().min(1),
  note: z.string().trim().max(280),
  acknowledged: z.array(AccessWarningCodeSchema).max(20),
});

const INVALID_INPUT = 'These changes could not be read. Reload the page and try again.';
const FOUNDER_ONLY_MESSAGE = 'Only a Founder can change access.';

export async function previewAccessAction(input: unknown): Promise<ReviewPreviewResult> {
  const session = await requireSection('roles');
  const parsed = PreviewInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: INVALID_INPUT };
  try {
    const preview = await previewAccessChanges(session, { changes: parsed.data.changes });
    return { ok: true, preview };
  } catch (error) {
    return { ok: false, message: mapAccessPreviewError(error) };
  }
}

export async function checkWithChangesAction(input: unknown): Promise<ReviewCheckResult> {
  const session = await requireSection('roles');
  const parsed = CheckInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: INVALID_INPUT };
  try {
    const preview = await previewAccessChanges(session, {
      changes: parsed.data.changes,
      person: parsed.data.person,
    });
    if (!preview.report) {
      return { ok: false, message: 'This person could not be checked. Try again in a moment.' };
    }
    return { ok: true, report: preview.report };
  } catch (error) {
    return { ok: false, message: mapAccessPreviewError(error) };
  }
}

export async function saveAccessAction(input: unknown): Promise<ReviewSaveResult> {
  const session = await requireSection('roles');
  if (!permissionChecker(session.roles)('admin.roles.write')) {
    return { ok: false, kind: 'error', message: FOUNDER_ONLY_MESSAGE };
  }
  const parsed = SaveInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, kind: 'invalid', message: INVALID_INPUT };
  const { changes, expectedRevision, note, acknowledged } = parsed.data;
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
  // Every Access tab (By area, By role, Check a person) reads the saved access.
  revalidatePath('/settings/access', 'layout');
  return { ok: true };
}
