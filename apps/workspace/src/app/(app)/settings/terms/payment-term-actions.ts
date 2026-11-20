'use server';

import { CreatePaymentTermBodySchema, UpdatePaymentTermBodySchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { createPaymentTerm, updatePaymentTerm } from '@/lib/api-master-data';

import { fail, ok, type ActionState } from '../action-state';
import { describeError } from '../admin-errors';
import { requireSection } from '../guard';

// Server Actions of the Payment terms panel on Settings > Saved terms (F1-Q49). Each asks the section permission
// again (settings.finance.write or admin.settings.write); the API checks the same grant.

const PATH = '/settings/terms';
const GONE = 'That payment term was removed or changed. The list is up to date now.';

function refused(error: unknown): ActionState {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
  if (status === 404 || status === 409) revalidatePath(PATH);
  return fail(describeError(error, 'change payment terms'));
}

export interface PaymentTermInput {
  code: string;
  name: string;
  netDays: string;
}

export async function addPaymentTermAction(input: PaymentTermInput): Promise<ActionState> {
  const session = await requireSection('terms');
  const days = input.netDays.trim();
  const parsed = CreatePaymentTermBodySchema.safeParse({
    code: input.code.toUpperCase(),
    name: input.name,
    netDays: /^\d{1,3}$/.test(days) ? Number(days) : Number.NaN,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(
      issue?.path[0] === 'netDays'
        ? 'Enter the days to pay as a whole number from 0 to 365.'
        : (issue?.message ?? 'Check the details and try again.'),
    );
  }
  try {
    await createPaymentTerm(session, parsed.data);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok(`Payment term ${parsed.data.name} added.`);
}

const Id = z.guid();

export async function renamePaymentTermAction(
  id: string,
  name: string,
  expectedVersion: number,
): Promise<ActionState> {
  const session = await requireSection('terms');
  const parsed = UpdatePaymentTermBodySchema.safeParse({ name, expectedVersion });
  if (!Id.safeParse(id).success) return fail(GONE);
  if (!parsed.success) return fail('Enter a name of up to 80 characters.');
  try {
    await updatePaymentTerm(session, id, parsed.data);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok('Payment term renamed.');
}

export async function setPaymentTermRetiredAction(
  id: string,
  retired: boolean,
  expectedVersion: number,
): Promise<ActionState> {
  const session = await requireSection('terms');
  const parsed = UpdatePaymentTermBodySchema.safeParse({ retired, expectedVersion });
  if (!Id.safeParse(id).success || !parsed.success) return fail(GONE);
  try {
    await updatePaymentTerm(session, id, parsed.data);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok(
    retired
      ? 'Payment term retired. It is no longer offered; records that already use it keep it.'
      : 'Payment term restored.',
  );
}
