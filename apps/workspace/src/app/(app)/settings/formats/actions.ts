'use server';

import {
  CurrencySchema,
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  type SettingKey,
} from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import {
  isLoadedVersion,
  numberSystemsFromForm,
  parseDateFormat,
  parseNumberSystems,
  parseVersionField,
  sameNumberSystems,
  withCurrencyDefault,
} from '@/components/settings/number-format';
import { isStaleSettingError, STALE_SETTING_MESSAGE } from '@/components/settings/stale-setting';
import { getSetting, putSetting } from '@/lib/api-admin';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';

// Each action is its own request, so the section permission is checked here, apart from the page
// that rendered the form. An action writes one setting, with the version the page loaded: a newer
// saved version makes the API answer 409, and the card then offers a reload instead of overwriting.
const NUMBER_SYSTEMS: SettingKey = 'format.number_systems';
const DATE: SettingKey = 'format.date';

const RELOAD = 'Reload this page and try again.';

/** A stale write says so and keeps the page as it is; any other failure is described for the admin. */
function failure(error: unknown, action: string): ActionState {
  if (isStaleSettingError(error)) return fail(STALE_SETTING_MESSAGE);
  return fail(describeError(error, action));
}

// Every screen formats money and dates through the layout's provider, so the layout reloads too.
// Only a write that went through gets here: after a stale failure the page keeps its versions,
// so the next Save cannot overwrite the newer change without a reload.
function refresh(): void {
  revalidatePath('/settings/formats');
  revalidatePath('/', 'layout');
}

/** Saves the grouping chosen for every currency (D30), as one setting. */
export async function saveNumberSystemsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('formats');
  const loaded = parseVersionField(formData.get('version'));
  if (!loaded.ok) return fail(RELOAD);
  const next = numberSystemsFromForm((field) => formData.get(field));
  if (next === null) {
    return {
      ...fail('Choose how amounts are grouped for each currency.'),
      fieldErrors: { numberSystems: 'Choose how amounts are grouped for each currency.' },
    };
  }
  try {
    // Every save appends a version, so a choice that changes nothing is not written.
    const current = await getSetting(session, NUMBER_SYSTEMS);
    const saved = parseNumberSystems(current.value);
    if (saved !== null && current.version === loaded.version && sameNumberSystems(saved, next)) {
      return ok('No changes to save.');
    }
    await putSetting(session, NUMBER_SYSTEMS, next, loaded.version);
  } catch (error) {
    return failure(error, 'change the number format');
  }
  refresh();
  return ok('Number format saved.');
}

/**
 * Puts one currency's grouping back to its default (D30, D32). The setting is one map, so the whole
 * map is written: it is read again here and only this currency changes, never from what the browser
 * holds. The version sent is the one the page loaded, so a map someone else saved meanwhile is
 * refused as stale instead of being overwritten.
 */
export async function resetNumberSystemAction(
  currency: string,
  loadedVersion: number | null,
): Promise<ActionState> {
  const session = await requireSection('formats');
  const parsed = CurrencySchema.safeParse(currency);
  if (!parsed.success) return fail('Unknown currency.');
  if (!isLoadedVersion(loadedVersion)) return fail(RELOAD);
  try {
    const current = await getSetting(session, NUMBER_SYSTEMS);
    const saved = parseNumberSystems(current.value);
    // A stored value the schema refuses reads as the defaults, as the page shows it.
    const reset = withCurrencyDefault(saved ?? DEFAULT_NUMBER_SYSTEMS, parsed.data);
    // Only when this page is current: otherwise the write goes out and the API answers stale, so
    // the card says so instead of toasting success over a row that still shows the old choice.
    if (saved !== null && current.version === loadedVersion && sameNumberSystems(saved, reset)) {
      return ok('Already at the default.');
    }
    await putSetting(session, NUMBER_SYSTEMS, reset, loadedVersion);
  } catch (error) {
    return failure(error, 'reset the number format');
  }
  refresh();
  return ok('Reset to default.');
}

/** Saves the date format used on customer documents. */
export async function saveDateFormatAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('formats');
  const loaded = parseVersionField(formData.get('version'));
  if (!loaded.ok) return fail(RELOAD);
  const raw = formData.get('dateFormat');
  const next = parseDateFormat(typeof raw === 'string' ? raw : '');
  if (next === null) {
    return {
      ...fail('Choose how dates are written.'),
      fieldErrors: { dateFormat: 'Choose how dates are written.' },
    };
  }
  try {
    const current = await getSetting(session, DATE);
    if (current.version === loaded.version && parseDateFormat(current.value) === next) {
      return ok('No changes to save.');
    }
    await putSetting(session, DATE, next, loaded.version);
  } catch (error) {
    return failure(error, 'change the date format');
  }
  refresh();
  return ok('Date format saved.');
}

/** Puts the date format back to its default, as a normal new version, with the stale check. */
export async function resetDateFormatAction(loadedVersion: number | null): Promise<ActionState> {
  const session = await requireSection('formats');
  if (!isLoadedVersion(loadedVersion)) return fail(RELOAD);
  try {
    const current = await getSetting(session, DATE);
    if (
      current.version === loadedVersion &&
      parseDateFormat(current.value) === DEFAULT_DATE_FORMAT
    ) {
      return ok('Already at the default.');
    }
    await putSetting(session, DATE, DEFAULT_DATE_FORMAT, loadedVersion);
  } catch (error) {
    return failure(error, 'reset the date format');
  }
  refresh();
  return ok('Reset to default.');
}
