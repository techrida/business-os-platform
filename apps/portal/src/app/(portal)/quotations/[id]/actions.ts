'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  AcceptQuotationBodySchema,
  acceptPortalQuotation,
  ApiError,
  RejectQuotationBodySchema,
  rejectPortalQuotation,
} from '@/lib/api';
import { isQuotationClosed } from '@/components/portal/quotation-closed';
import { getSession } from '@/lib/session';

/**
 * Accept and reject, for the customer. Serves the NFR "no double decisions": each form carries an
 * Idempotency-Key the page generated once per render, so a double click or a retry after a timeout
 * records the decision once. A 409 means the quotation moved (answered, expired, revised) since
 * the page was rendered, so the customer is asked to reload instead of deciding on stale terms.
 * Error text is ours, never the API's: its detail could name internal ids or rules.
 */

export interface RespondState {
  /** The key the next submit will use. Rotated after a definite refusal, kept after an unknown outcome. */
  key: string;
  error?: string;
  /** Set when the page is out of date and the customer should reload it. */
  reload?: boolean;
  nameError?: string;
  confirmError?: string;
  commentError?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;
const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** The id and key every submit needs, or a state that asks for a reload. */
async function prepare(
  prev: RespondState,
  form: FormData,
): Promise<
  | {
      ok: true;
      id: string;
      key: string;
      session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
    }
  | { ok: false; state: RespondState }
> {
  const id = text(form, 'quotationId');
  if (!UUID.test(id))
    return { ok: false, state: { key: prev.key, error: INCOMPLETE, reload: true } };
  const session = await getSession();
  // These actions run no layout, so they check the kind themselves: a vendor session is refused
  // exactly like a signed-out visitor, before anything reaches the API.
  if (!session || session.orgKind !== 'customer') {
    redirect(`/auth/login?returnTo=${encodeURIComponent(`/quotations/${id}`)}`);
  }
  const submitted = text(form, 'idempotencyKey');
  return { ok: true, id, key: KEY.test(submitted) ? submitted : randomUUID(), session };
}

/** Words for a refused or failed call. `definite` refusals rotate the key; unknown outcomes keep it. */
function failed(err: unknown, key: string, id: string): RespondState {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 401) redirect(`/auth/login?returnTo=${encodeURIComponent(`/quotations/${id}`)}`);
  // The company closed it (a Lost deal) while this page sat open: show the "no longer open" page, not an error.
  if (isQuotationClosed(err)) {
    revalidatePath(`/quotations/${id}`);
    redirect(`/quotations/${id}`);
  }
  if (status === 409) {
    return {
      key: randomUUID(),
      reload: true,
      error:
        'This quotation has changed since you opened it, or it has already been answered. Reload the page to see where it stands.',
    };
  }
  if (status === 404 || status === 403) return { key: randomUUID(), error: 'Quotation not found.' };
  if (status >= 400 && status < 500) {
    return {
      key: randomUUID(),
      error: 'We could not record your response. Check the form and try again.',
    };
  }
  // A timeout or 5xx: the first call may have landed. The same key makes a retry safe.
  return {
    key,
    error:
      'We could not confirm your response just now. Please try again; it will only be recorded once.',
  };
}

export async function acceptAction(prev: RespondState, form: FormData): Promise<RespondState> {
  const ready = await prepare(prev, form);
  if (!ready.ok) return ready.state;
  const { id, key, session } = ready;

  const name = text(form, 'acceptedByName').trim();
  const confirmed = text(form, 'confirm') === 'on';
  const parsed = AcceptQuotationBodySchema.safeParse({ acceptedByName: name, confirm: confirmed });
  if (!parsed.success) {
    // Nothing reached the API, so the same key is still unused.
    return {
      key,
      ...(name === '' || name.length > 200
        ? { nameError: 'Type your full name to sign this acceptance (up to 200 characters).' }
        : {}),
      ...(!confirmed ? { confirmError: 'Tick the box to confirm that you accept.' } : {}),
    };
  }

  try {
    await acceptPortalQuotation(session, id, parsed.data, key);
  } catch (err) {
    return failed(err, key, id);
  }
  revalidatePath(`/quotations/${id}`);
  revalidatePath('/');
  // `redirect` throws, so it stays outside the try block.
  redirect(`/quotations/${id}?responded=accepted`);
}

export async function rejectAction(prev: RespondState, form: FormData): Promise<RespondState> {
  const ready = await prepare(prev, form);
  if (!ready.ok) return ready.state;
  const { id, key, session } = ready;

  const parsed = RejectQuotationBodySchema.safeParse({ comment: text(form, 'comment') });
  if (!parsed.success) {
    return {
      key,
      commentError: 'Tell us why you are rejecting it (up to 2,000 characters).',
    };
  }

  try {
    await rejectPortalQuotation(session, id, parsed.data, key);
  } catch (err) {
    return failed(err, key, id);
  }
  revalidatePath(`/quotations/${id}`);
  revalidatePath('/');
  redirect(`/quotations/${id}?responded=rejected`);
}
