'use server';

import { CompanyProfileSchema, type SettingKey } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import {
  CARD_WRITES,
  isCompanyCard,
  mergeProfile,
  planCard,
  sameProfile,
} from '@/components/settings/company-profile';
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

  const allowed: readonly string[] = CARD_WRITES[card];
  const write = async (key: SettingKey, value: unknown) => {
    if (!allowed.includes(key)) throw new Error(`The ${card} card cannot write ${key}.`);
    await putSetting(session, key, value);
  };

  let wrote = false;
  try {
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
    revalidatePath('/settings/company');
    if (error instanceof ProfileUnreadable) return fail(error.message);
    return fail(describeError(error, 'change the company profile'));
  }
  revalidatePath('/settings/company');
  return ok(wrote ? 'Changes saved.' : 'No changes to save.');
}

/** Merge into the stored profile and write it when it changed. Fails closed on an unreadable stored value. */
async function writeProfile(
  session: Session,
  patch: Parameters<typeof mergeProfile>[1],
  write: (key: SettingKey, value: unknown) => Promise<void>,
): Promise<boolean> {
  const current = CompanyProfileSchema.safeParse(
    (await getSetting(session, 'entity.profile')).value,
  );
  if (!current.success) {
    throw new ProfileUnreadable();
  }
  const merged = CompanyProfileSchema.safeParse(mergeProfile(current.data, patch));
  if (!merged.success) throw new ProfileUnreadable();
  if (sameProfile(current.data, merged.data)) return false;
  await write('entity.profile', merged.data);
  return true;
}
