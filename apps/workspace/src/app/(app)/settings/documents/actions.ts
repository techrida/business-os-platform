'use server';

import { DocumentStyleSchema, HexColourSchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { putSetting } from '@/lib/api-admin';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';
import { loadPreviews, type DocumentPreviews } from './previews';

// Each is its own request, so the section permission is checked here, apart from the page that
// rendered the form. The guard redirects (throws), so it stays outside every try block.

/**
 * Saves the document style. The value is built from exactly two form fields, so nothing else a
 * request carries can reach the setting, and it is validated against the shared schema.
 */
export async function saveDocumentStyleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('documents');
  const layout = formData.get('layout');
  const primaryColour = formData.get('primaryColour');
  const parsed = DocumentStyleSchema.safeParse({
    layout: typeof layout === 'string' ? layout : '',
    primaryColour: typeof primaryColour === 'string' ? primaryColour : '',
  });
  if (!parsed.success) {
    const colourWrong = parsed.error.issues.some((issue) => issue.path[0] === 'primaryColour');
    return fail(
      colourWrong
        ? 'Enter the colour as six hex digits, such as #1d4ed8.'
        : 'Choose one of the layouts.',
    );
  }
  try {
    await putSetting(session, 'document.style', parsed.data);
  } catch (error) {
    return fail(describeError(error, 'change the document style'));
  }
  revalidatePath('/settings/documents');
  return ok('Document style saved.');
}

/**
 * The five previews in a colour, for the form's colour picker. `null` means "keep what is shown":
 * the colour was not a valid hex. A layout that fails to draw is `null` inside the result.
 */
export async function previewsAction(colour: string): Promise<DocumentPreviews | null> {
  const session = await requireSection('documents');
  const parsed = HexColourSchema.safeParse(colour);
  if (!parsed.success) return null;
  return loadPreviews(session, parsed.data);
}
