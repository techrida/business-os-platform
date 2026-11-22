'use server';

import { SETTING_DEFAULTS, StoredCompanyProfileSchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import {
  CARD_WRITES,
  RESET_KEY,
  emptyProfilePatch,
  isCompanyCard,
  isResettableCard,
  mergeProfile,
  planCard,
  readExpectedVersion,
  sameProfile,
  type CompanyKey,
} from '@/components/settings/company-profile';
import { isStaleSettingError, STALE_SETTING_MESSAGE } from '@/components/settings/stale-setting';
import { getSetting, putSetting } from '@/lib/api-admin';
import type { Session } from '@/lib/session';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';

// Saves one Company profile card. Each action is its own request, so the section permission is
// checked here, apart from the page. A card may only write the keys listed for it in CARD_WRITES.
//
// The profile is one setting value (`entity.profile`): the action reads the current value, replaces
// only the submitted card's fields and writes the whole value back, so one card never wipes another.
// The PAN/VAT number is written to `entity.pan_vat_no` only; the profile's own panVatNo stays as it is.
//
// Every write carries the version the PAGE loaded for that setting (a hidden field of the form),
// and the API refuses it with 409 `stale_setting` when someone saved a newer one. The action reads
// the current VALUE to merge into, never the current version: asking for the version here would
// make the check always pass. A stale refusal does not revalidate the page, so the person's typed
// values stay and a retry cannot quietly pass over the other person's change.

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

class ProfileUnreadable extends Error {
  constructor() {
    super('The saved company profile could not be read, so nothing was changed.');
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type Write = (key: CompanyKey, value: unknown) => Promise<void>;

/** The page's loaded versions for the keys a card writes, or null when one is missing (nothing is saved then). */
function loadedVersions(
  keys: readonly CompanyKey[],
  form: Parameters<typeof readExpectedVersion>[0],
): Map<CompanyKey, number | null> | null {
  const versions = new Map<CompanyKey, number | null>();
  for (const key of keys) {
    const version = readExpectedVersion(form, key);
    if (version === undefined) return null;
    versions.set(key, version);
  }
  return versions;
}

/** A write that sends the page-loaded version. It never looks the version up itself. */
function guardedWrite(
  session: Session,
  allowed: readonly CompanyKey[],
  versions: Map<CompanyKey, number | null>,
  label: string,
): Write {
  return async (key, value) => {
    const expected = versions.get(key);
    if (!allowed.includes(key) || expected === undefined) {
      throw new Error(`The ${label} card cannot write ${key}.`);
    }
    await putSetting(session, key, value, expected);
  };
}

export async function saveCompanyCardAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('company');
  const card = text(formData, 'card');
  if (!isCompanyCard(card)) return fail('Unknown card.');

  const plan = planCard(card, formData);
  if (!plan.ok) {
    const errors = Object.values(plan.errors);
    const message =
      errors.length === 1 ? (errors[0] as string) : 'Check the highlighted fields and try again.';
    return { ...fail(message), fieldErrors: plan.errors };
  }

  const allowed: readonly CompanyKey[] = CARD_WRITES[card];
  const versions = loadedVersions(allowed, formData);
  // A form with no loaded version cannot be checked against the saved one, so it is not saved.
  if (versions === null) return fail(STALE_SETTING_MESSAGE);
  const write = guardedWrite(session, allowed, versions, card);

  let wrote = false;
  try {
    // The Identity card writes two settings, one after the other (the API has no multi-key write).
    // If the second is refused as stale, the first is already saved: the display name is stored, the
    // PAN or VAT number is not. Either order leaves the same kind of half, so the order stays; the
    // message says which half went in and tells the person to reload.
    const { profile, panVatNo, address } = plan.value;
    if (profile !== undefined) wrote = (await writeProfile(session, profile, write)) || wrote;
    if (panVatNo !== undefined) {
      const current = await getSetting(session, 'entity.pan_vat_no');
      if (!same(current.value ?? null, panVatNo)) {
        await write('entity.pan_vat_no', panVatNo);
        wrote = true;
      }
    }
    if (address !== undefined) {
      const current = await getSetting(session, 'entity.address');
      if (!same(current.value ?? null, address)) {
        await write('entity.address', address);
        wrote = true;
      }
    }
  } catch (error) {
    // Checked before describeError, which would pass the API's own text through. No revalidation:
    // the page must keep the version the person loaded, and the screen their typed values.
    if (isStaleSettingError(error)) {
      if (!wrote) return fail(STALE_SETTING_MESSAGE);
      return {
        ...fail(
          'The display name was saved, but the PAN or VAT number was changed by someone else. Reload to see the latest.',
        ),
        stale: true,
      };
    }
    revalidatePath('/settings/company');
    if (error instanceof ProfileUnreadable) return fail(error.message);
    return fail(describeError(error, 'change the company profile'));
  }
  revalidatePath('/settings/company');
  return ok(wrote ? 'Changes saved.' : 'No changes to save.');
}

/**
 * The undo icon of one card (D32): the address is cleared; Contact or Signatory is put back to
 * empty inside the CURRENT profile, so the logo, the display name and the other card stay. It is a
 * normal save, so it lands in the audit trail. `expectedVersion` is the version the page loaded.
 */
export async function resetCompanyCardAction(
  card: string,
  expectedVersion: number | null,
): Promise<ActionState> {
  const session = await requireSection('company');
  if (!isResettableCard(card)) return fail('Unknown card.');
  if (expectedVersion !== null && !Number.isSafeInteger(expectedVersion)) {
    return fail(STALE_SETTING_MESSAGE);
  }

  const key = RESET_KEY[card];
  const write = guardedWrite(
    session,
    [key],
    new Map<CompanyKey, number | null>([[key, expectedVersion]]),
    card,
  );
  try {
    if (card === 'address') {
      await write('entity.address', SETTING_DEFAULTS['entity.address']);
    } else {
      // Nothing to write when someone else already emptied it; the page still refreshes below.
      await writeProfile(session, emptyProfilePatch(card), write);
    }
  } catch (error) {
    if (isStaleSettingError(error)) return fail(STALE_SETTING_MESSAGE);
    revalidatePath('/settings/company');
    if (error instanceof ProfileUnreadable) return fail(error.message);
    return fail(describeError(error, 'reset the company profile'));
  }
  revalidatePath('/settings/company');
  return ok('Reset to default.');
}

/** Merge into the stored profile and write it when it changed. Fails closed on an unreadable stored value. */
async function writeProfile(
  session: Session,
  patch: Parameters<typeof mergeProfile>[1],
  write: Write,
): Promise<boolean> {
  const current = StoredCompanyProfileSchema.safeParse(
    (await getSetting(session, 'entity.profile')).value,
  );
  if (!current.success) {
    throw new ProfileUnreadable();
  }
  // The API holds a write to the strict rules; this only checks the merged value still has the profile's shape.
  const merged = StoredCompanyProfileSchema.safeParse(mergeProfile(current.data, patch));
  if (!merged.success) throw new ProfileUnreadable();
  if (sameProfile(current.data, merged.data)) return false;
  await write('entity.profile', merged.data);
  return true;
}
