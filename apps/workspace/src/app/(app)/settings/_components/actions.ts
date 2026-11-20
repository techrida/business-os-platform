'use server';

import { SETTING_DEFAULTS, SettingKeySchema, type SettingKey } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { isStaleSettingError, STALE_SETTING_MESSAGE } from '@/components/settings/stale-setting';
import { putSetting } from '@/lib/api-admin';
import { settingsSection, type SettingsSectionId } from '@/lib/settings-nav';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';
import { CARD_KEYS, RESET_KEYS } from './card-keys';
import { settingKind, settingLabel, toFieldValue, type SettingFieldValue } from './setting-fields';
import { parseSettingInput } from './setting-input';

// Saves settings for a section. Each action is its own request, so the section permission is checked
// here, apart from the page that rendered the form. A section may only write the keys it owns.

export interface SettingChangePayload {
  key: SettingKey;
  value: SettingFieldValue;
  expectedVersion: number | null;
}

export interface SavedSettingEntry {
  key: SettingKey;
  value: SettingFieldValue;
  version: number;
}

export interface SaveSettingsPageResult {
  status: 'ok' | 'partial' | 'error';
  message: string;
  /** Keys written successfully, with their normalised value and new version for updating the baseline. */
  saved: SavedSettingEntry[];
  /** Validation errors before write or API error on the failing key. */
  fieldErrors: Partial<Record<SettingKey, string>>;
  /** Keys rejected with 409 stale_setting so the page can offer Reload. */
  staleKeys: SettingKey[];
}

function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Saves all changed settings on a settings page in one Server Action call.
 *
 * The API writes one key at a time (`PUT /v1/admin/settings/:key` with `expectedVersion`).
 * To achieve all-or-report semantics:
 * 1. Authorise the section and verify every key is owned by it and has a valid expectedVersion.
 * 2. Parse and validate every changed value up front; if any fails, write nothing.
 * 3. Write sequentially in order with `expectedVersion`.
 * 4. If a write fails mid-way, stop writing, report which settings saved and which failed, and
 *    return the saved entries so the client promotes saved keys to the new baseline while keeping
 *    unsaved/failed values intact in the form.
 */
export async function saveSettingsPageAction(
  section: SettingsSectionId,
  changes: readonly SettingChangePayload[],
): Promise<SaveSettingsPageResult> {
  const allowed: readonly SettingKey[] | undefined = Object.hasOwn(CARD_KEYS, section)
    ? CARD_KEYS[section as keyof typeof CARD_KEYS]
    : undefined;
  if (allowed === undefined) {
    return {
      status: 'error',
      message: 'Unknown settings section.',
      saved: [],
      fieldErrors: {},
      staleKeys: [],
    };
  }
  const session = await requireSection(section);

  if (changes.length === 0) {
    return {
      status: 'ok',
      message: 'No changes to save.',
      saved: [],
      fieldErrors: {},
      staleKeys: [],
    };
  }

  const seen = new Set<SettingKey>();
  const validated: { key: SettingKey; parsed: unknown; expectedVersion: number | null }[] = [];
  const fieldErrors: Partial<Record<SettingKey, string>> = {};

  for (const change of changes) {
    const parsedKey = SettingKeySchema.safeParse(change.key);
    if (!parsedKey.success || !allowed.includes(parsedKey.data) || seen.has(parsedKey.data)) {
      return {
        status: 'error',
        message: 'Unknown setting.',
        saved: [],
        fieldErrors: {},
        staleKeys: [],
      };
    }
    seen.add(parsedKey.data);
    if (change.expectedVersion !== null && !Number.isInteger(change.expectedVersion)) {
      return {
        status: 'error',
        message: 'Reload the page and try again.',
        saved: [],
        fieldErrors: {},
        staleKeys: [],
      };
    }
    const parsed = parseSettingInput(parsedKey.data, change.value);
    if (parsed.ok) {
      validated.push({
        key: parsedKey.data,
        parsed: parsed.value,
        expectedVersion: change.expectedVersion,
      });
    } else {
      fieldErrors[parsedKey.data] = parsed.message;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      status: 'error',
      message: 'Check the highlighted fields and try again.',
      saved: [],
      fieldErrors,
      staleKeys: [],
    };
  }

  const saved: SavedSettingEntry[] = [];
  const staleKeys: SettingKey[] = [];

  for (let i = 0; i < validated.length; i += 1) {
    const item = validated[i]!;
    try {
      const response = await putSetting(session, item.key, item.parsed, item.expectedVersion);
      saved.push({
        key: item.key,
        value: toFieldValue(settingKind(item.key), item.parsed),
        version: response.version,
      });
    } catch (error) {
      const isStale = isStaleSettingError(error);
      const errorMessage = isStale
        ? STALE_SETTING_MESSAGE
        : describeError(error, 'change settings');
      fieldErrors[item.key] = errorMessage;
      if (isStale) staleKeys.push(item.key);

      if (saved.length > 0) {
        revalidatePath(settingsSection(section).href);
        revalidatePath('/', 'layout');
        const savedLabels = formatList(saved.map((entry) => settingLabel(entry.key)));
        const failedLabel = settingLabel(item.key);
        const remaining = validated.slice(i + 1).map((entry) => settingLabel(entry.key));
        const suffix =
          remaining.length > 0
            ? ` ${formatList(remaining)} ${remaining.length === 1 ? 'was' : 'were'} not saved.`
            : '';
        return {
          status: 'partial',
          message: `Saved ${savedLabels}. Could not save ${failedLabel}.${suffix}`,
          saved,
          fieldErrors,
          staleKeys,
        };
      }

      if (!isStale) revalidatePath(settingsSection(section).href);
      return {
        status: 'error',
        message: errorMessage,
        saved: [],
        fieldErrors,
        staleKeys,
      };
    }
  }

  revalidatePath(settingsSection(section).href);
  revalidatePath('/', 'layout');
  return {
    status: 'ok',
    message: 'Changes saved.',
    saved,
    fieldErrors: {},
    staleKeys: [],
  };
}

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

/** Legacy single-card FormData action kept for compatibility with existing callers/tests. */
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
 *
 * `loadedVersion` is the version the page loaded (null when it loaded the default). It goes to the API
 * as `expectedVersion`, so a page that is out of date cannot overwrite what another founder saved
 * since: the API refuses, the person sees the stale message and nothing is written. Anything that is
 * not a whole number or null fails closed, because a reset without it would be an unconditional write.
 */
export async function resetSettingAction(
  section: SettingsSectionId,
  key: SettingKey,
  loadedVersion: number | null,
): Promise<ActionState> {
  const allowed: readonly SettingKey[] | undefined = Object.hasOwn(RESET_KEYS, section)
    ? RESET_KEYS[section as keyof typeof RESET_KEYS]
    : undefined;
  if (allowed === undefined) return fail('Unknown settings section.');
  const session = await requireSection(section);

  const parsed = SettingKeySchema.safeParse(key);
  if (!parsed.success || !allowed.includes(parsed.data)) return fail('Unknown setting.');
  if (loadedVersion !== null && !Number.isInteger(loadedVersion)) {
    return fail('Reload the page and try again.');
  }

  try {
    await putSetting(session, parsed.data, SETTING_DEFAULTS[parsed.data], loadedVersion);
  } catch (error) {
    // A stale reset changed nothing, so there is nothing to refresh; the message tells them to reload.
    if (isStaleSettingError(error)) return fail(STALE_SETTING_MESSAGE);
    revalidatePath(settingsSection(section).href);
    return fail(describeError(error, 'reset this setting'));
  }
  revalidatePath(settingsSection(section).href);
  // Settings feed the shell and the document screens too, so the layout refreshes with the section.
  revalidatePath('/', 'layout');
  return ok('Reset to default.');
}
