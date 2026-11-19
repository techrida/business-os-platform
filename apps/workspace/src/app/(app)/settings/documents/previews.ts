import 'server-only';

import { DOCUMENT_LAYOUTS, type DocumentLayout } from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

/** One sample quotation per layout, drawn by the real renderer. `null` = that preview failed. */
export type DocumentPreviews = Record<DocumentLayout, string | null>;

const PREVIEW_PATH = '/v1/admin/settings/documents/preview';

const PreviewSchema = z.object({ html: z.string().min(1) });

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The self-contained A4 HTML of a sample quotation in this layout and colour. Throws on any failure. */
export async function loadPreview(
  session: Session,
  layout: DocumentLayout,
  primaryColour: string,
): Promise<string> {
  const res = await apiFetch(session, PREVIEW_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout, primaryColour }),
  });
  const body = await readJson(res);
  if (!res.ok)
    throw new ApiError(res.status, `POST ${PREVIEW_PATH} failed with ${res.status}`, body);
  const parsed = PreviewSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `POST ${PREVIEW_PATH} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data.html;
}

/**
 * All five layouts in this colour. One layout failing leaves a `null` for it and never blocks the
 * others, so the page shows a placeholder card instead of an error.
 */
export async function loadPreviews(
  session: Session,
  primaryColour: string,
): Promise<DocumentPreviews> {
  const settled = await Promise.allSettled(
    DOCUMENT_LAYOUTS.map((layout) => loadPreview(session, layout, primaryColour)),
  );
  const previews = {} as DocumentPreviews;
  DOCUMENT_LAYOUTS.forEach((layout, index) => {
    const result = settled[index];
    previews[layout] = result?.status === 'fulfilled' ? result.value : null;
  });
  return previews;
}
