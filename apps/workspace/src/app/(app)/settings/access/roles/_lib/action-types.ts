// What the access Server Actions hand back to the review dialog. A plain module, because a
// 'use server' file may only export async functions. The shapes match the dialog's `runPreview` and
// `runSave` callbacks.
import type { AccessPreviewResponse } from '@bos/contracts';

import type { AccessSaveFailure } from '@/lib/api-access';

export type PreviewActionResult =
  { ok: true; preview: AccessPreviewResponse } | { ok: false; message: string };

export type SaveActionResult = { ok: true } | ({ ok: false } & AccessSaveFailure);
