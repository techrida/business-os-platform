'use server';

import { SETTING_DEFAULTS, SettingKeySchema, type SettingKey } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { putSetting } from '@/lib/api-admin';
import { settingsSection, type SettingsSectionId } from '@/lib/settings-nav';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';
import { CARD_KEYS, RESET_KEYS } from './card-keys';
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

/**
 * Puts one setting back to its default (D32). A reset is a normal save of the default value, so it
 * appends a version and lands in the audit trail like any other change. One setting only, and only a
 * key the section owns; the section permission is checked here, apart from the page.
 */
export async function resetSettingAction(
  section: SettingsSectionId,
  key: SettingKey,
): Promise<ActionState> {
  const allowed: readonly SettingKey[] | undefined = Object.hasOwn(RESET_KEYS, section)
    ? RESET_KEYS[section as keyof typeof RESET_KEYS]
    : undefined;
  if (allowed === undefined) return fail('Unknown settings section.');
  const session = await requireSection(section);

  const parsed = SettingKeySchema.safeParse(key);
  if (!parsed.success || !allowed.includes(parsed.data)) return fail('Unknown setting.');

  try {
    await putSetting(session, parsed.data, SETTING_DEFAULTS[parsed.data]);
  } catch (error) {
    revalidatePath(settingsSection(section).href);
    return fail(describeError(error, 'reset this setting'));
  }
  revalidatePath(settingsSection(section).href);
  // Settings feed the shell and the document screens too, so the layout refreshes with the section.
  revalidatePath('/', 'layout');
  return ok('Reset to default.');
}
