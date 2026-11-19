'use server';

import { SettingKeySchema, type SettingKey } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { putSetting } from '@/lib/api-admin';
import { settingsSection, type SettingsSectionId } from '@/lib/settings-nav';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';
import { CARD_KEYS } from './card-keys';
import { parseSettingInput } from './setting-input';

// Saves one settings card. Each action is its own request, so the section permission is checked
// here, apart from the page that rendered the form. A card may only write the keys its section owns.

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

export async function saveCardAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = text(formData, 'section') as SettingsSectionId;
  const allowed: readonly SettingKey[] | undefined = Object.hasOwn(CARD_KEYS, id)
    ? CARD_KEYS[id as keyof typeof CARD_KEYS]
    : undefined;
  if (allowed === undefined) return fail('Unknown settings section.');
  const session = await requireSection(id);

  const keys = formData.getAll('key').filter((k): k is string => typeof k === 'string');
  const parsedKeys = keys.map((k) => SettingKeySchema.safeParse(k));
  if (parsedKeys.some((k) => !k.success)) return fail('Unknown setting.');
  const wanted = parsedKeys.flatMap((k) => (k.success ? [k.data] : []));
  if (wanted.some((key) => !allowed.includes(key))) return fail('Unknown setting.');

  const raw = (key: SettingKey) =>
    formData.getAll(`v:${key}`).filter((v): v is string => typeof v === 'string');
  // Only what the person changed is written: every save appends a version.
  const changed = wanted.filter((key) => raw(key).join(',') !== text(formData, `i:${key}`));
  if (changed.length === 0) return ok('No changes to save.');

  const fields = Object.fromEntries(wanted.map((key) => [key, raw(key).join(',')]));
  const fieldErrors: Record<string, string> = {};
  const values: [SettingKey, unknown][] = [];
  for (const key of changed) {
    const input = parseSettingInput(key, raw(key));
    if (input.ok) values.push([key, input.value]);
    else fieldErrors[key] = input.message;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ...fail('Check the highlighted fields and try again.', fields), fieldErrors };
  }

  for (const [key, value] of values) {
    try {
      await putSetting(session, key, value);
    } catch (error) {
      revalidatePath(settingsSection(id).href);
      return fail(describeError(error, 'change settings'), fields);
    }
  }
  revalidatePath(settingsSection(id).href);
  return ok('Changes saved.');
}
