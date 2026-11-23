'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  isTermKind,
  normalizeBody,
  termKindLabel,
  validatePreset,
} from '@/components/settings/term-presets/term-preset-model';
import { ApiError } from '@/lib/api';
import { createTermPreset, deleteTermPreset, updateTermPreset } from '@/lib/api-term-presets';

import { fail, ok, type ActionState } from '../action-state';
import { describeError } from '../admin-errors';
import { requireSection } from '../guard';

// Server Actions for term sets (Settings > Saved terms). Resetting every set to the app defaults is
// `resetSettingAction('terms', 'quotation.term_presets')` in ../_components/actions.ts: the same section
// guard, and it writes exactly the default value. Each action is its own request, so the section permission (the
// live grant settings.finance.write or admin.settings.write) is re-checked here, apart from the page that
// rendered the list. The API still enforces every write.

const PATH = '/settings/terms';

const Id = z.guid();

export interface SavePresetInput {
  /** Present when editing; absent when adding. */
  id?: string | undefined;
  kind: string;
  name: string;
  body: string;
  /** What the dialog opened with: only changed fields are sent on an edit. */
  initialName?: string | undefined;
  initialBody?: string | undefined;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const taken = (name: string, kind: string): ActionState => ({
  ...fail(`There is already a term set named "${name}" in ${kind}. Choose another name.`),
  fieldErrors: { name: 'This name is already used here. Choose another.' },
});

export async function savePresetAction(input: SavePresetInput): Promise<ActionState> {
  const session = await requireSection('terms');
  if (!isTermKind(input.kind)) return fail('Unknown kind of term set.');
  const kind = input.kind;
  const checked = validatePreset(kind, { name: str(input.name), body: str(input.body) });
  if (!checked.ok) {
    return {
      ...fail('Check the highlighted fields and try again.'),
      fieldErrors: checked.fieldErrors,
    };
  }
  const { name, body } = checked.value;

  try {
    if (input.id === undefined) {
      await createTermPreset(session, { kind, name, body });
    } else {
      if (!Id.safeParse(input.id).success) return fail('That term set no longer exists.');
      const changes = {
        ...(name !== str(input.initialName).trim() ? { name } : {}),
        // Compared the way it is stored, so an untouched legacy text is not rewritten.
        ...(body !== normalizeBody(str(input.initialBody)) ? { body } : {}),
      };
      if (Object.keys(changes).length === 0) return ok('No changes to save.');
      await updateTermPreset(session, input.id, changes);
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return taken(name, termKindLabel(kind));
    if (error instanceof ApiError && error.status === 404) {
      revalidatePath(PATH);
      return fail('That term set was removed by someone else. The list is up to date now.');
    }
    return fail(describeError(error, 'change term sets'));
  }
  revalidatePath(PATH);
  return ok(input.id === undefined ? 'Term set added.' : 'Term set saved.');
}

export async function removePresetAction(id: string): Promise<ActionState> {
  const session = await requireSection('terms');
  if (!Id.safeParse(id).success) return fail('That term set no longer exists.');
  try {
    await deleteTermPreset(session, id);
  } catch (error) {
    // Already gone: the list is what the person wanted anyway.
    if (!(error instanceof ApiError && error.status === 404)) {
      return fail(describeError(error, 'remove term sets'));
    }
  }
  revalidatePath(PATH);
  return ok('Term set removed.');
}

/** Makes a term set the default of its kind (new quotations start with it), or clears it. At most one per kind: the API moves it. */
export async function setDefaultPresetAction(id: string, isDefault: boolean): Promise<ActionState> {
  const session = await requireSection('terms');
  if (!Id.safeParse(id).success) return fail('That term set no longer exists.');
  try {
    await updateTermPreset(session, id, { isDefault });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      revalidatePath(PATH);
      return fail('That term set was removed by someone else. The list is up to date now.');
    }
    return fail(describeError(error, 'change term sets'));
  }
  revalidatePath(PATH);
  return ok(isDefault ? 'Default term set chosen.' : 'Default cleared.');
}
