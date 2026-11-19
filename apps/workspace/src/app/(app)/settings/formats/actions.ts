'use server';

import type { SettingKey } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { parseNumberSystem } from '@/components/settings/number-format';
import { getSetting, putSetting } from '@/lib/api-admin';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';

// Saves the number format. It is its own request, so the section permission is checked here, apart
// from the page that rendered the form, and the action can write one setting only.
const KEY: SettingKey = 'format.number_system';

export async function saveNumberSystemAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('formats');
  const raw = formData.get('numberSystem');
  const next = parseNumberSystem(typeof raw === 'string' ? raw : '');
  if (next === null) {
    return {
      ...fail('Choose how amounts are grouped.'),
      fieldErrors: { numberSystem: 'Choose how amounts are grouped.' },
    };
  }
  try {
    // Every save appends a version, so an unchanged choice is not written.
    const current = await getSetting(session, KEY);
    if (parseNumberSystem(current.value) === next) return ok('No changes to save.');
    await putSetting(session, KEY, next);
  } catch (error) {
    return fail(describeError(error, 'change the number format'));
  }
  revalidatePath('/settings/formats');
  return ok('Number format saved.');
}
