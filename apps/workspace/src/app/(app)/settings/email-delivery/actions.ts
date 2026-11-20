'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { resendEmail } from '@/lib/api-email-delivery';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';

// The Resend button's Server Action. The section is re-checked here because an action is its own request; the API
// still decides (it needs email_delivery.resend and scopes the row to the caller's company).

const PATH = '/settings/email-delivery';

export async function resendEmailAction(id: string): Promise<ActionState> {
  const session = await requireSection('email-delivery');
  if (!z.guid().safeParse(id).success) return fail('This email could not be found.');
  try {
    const result = await resendEmail(session, id);
    revalidatePath(PATH);
    return ok(
      result.outcome === 'queued'
        ? 'The email is queued and will be sent again in a moment.'
        : 'This email is already waiting to be sent.',
    );
  } catch (error) {
    // A 409 (already delivered) means the page was out of date: refresh it so the row shows its real state.
    revalidatePath(PATH);
    return fail(describeError(error, 'resend emails'));
  }
}
