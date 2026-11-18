'use server';

import { RateString, SettingKeySchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { addFxRate, putSetting } from '@/lib/api-admin';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSession } from '../guard';
import { parseSettingInput } from './setting-input';

// Server Actions for the settings page (FX rates and settings values). The session is re-checked
// here because each action is its own request, apart from the page that rendered the form.

const PATH = '/admin/settings';

const FxSchema = z.object({
  currency: z.enum(['INR', 'USD'], 'Choose INR or USD. NPR is the books currency.'),
  rateNpr: RateString.refine((v) => Number(v) > 0, 'The rate must be greater than 0.'),
  rateDate: z.iso.date('Enter the date the rate applies to.'),
  source: z.string().trim().max(200).default('manual'),
});

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

export async function addFxRateAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession(PATH);
  const fields = {
    currency: text(formData, 'currency'),
    rateNpr: text(formData, 'rateNpr').trim(),
    rateDate: text(formData, 'rateDate'),
    source: text(formData, 'source').trim(),
  };
  const parsed = FxSchema.safeParse({ ...fields, source: fields.source || undefined });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message =
      issue?.path[0] === 'rateNpr' && issue.code === 'invalid_format'
        ? 'Enter the rate as a number with up to 6 decimals, for example 133.5.'
        : (issue?.message ?? 'Check the form and try again.');
    return {
      ...fail(message, fields),
      fieldErrors: issue ? { [String(issue.path[0])]: message } : {},
    };
  }

  try {
    await addFxRate(session, parsed.data);
  } catch (error) {
    return fail(describeError(error, 'add FX rates'), fields);
  }
  revalidatePath(PATH);
  return ok(
    `Added ${parsed.data.currency} rate ${parsed.data.rateNpr} for ${parsed.data.rateDate}.`,
  );
}

export async function saveSettingAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession(PATH);
  const key = SettingKeySchema.safeParse(text(formData, 'key'));
  if (!key.success) return fail('Unknown setting.');

  const raw = formData.getAll('value').filter((v): v is string => typeof v === 'string');
  const input = parseSettingInput(key.data, raw);
  if (!input.ok)
    return {
      ...fail(input.message, { value: raw.join(',') }),
      fieldErrors: { value: input.message },
    };

  try {
    const { version } = await putSetting(session, key.data, input.value);
    revalidatePath(PATH);
    return ok(`Saved as version ${version}.`);
  } catch (error) {
    return fail(describeError(error, 'change settings'), { value: raw.join(',') });
  }
}
