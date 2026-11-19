'use server';

import { RateString } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { addFxRate } from '@/lib/api-admin';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';

// Server Action for the exchange-rate form. The section permission is re-checked here because each
// action is its own request, apart from the page that rendered the form.

const PATH = '/settings/currencies';

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
  const session = await requireSection('currencies');
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
