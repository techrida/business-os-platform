'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { kathmanduToday } from '@/components/p2/quotations/eligibility';
import {
  parseCancel,
  parseConfirmAcceptance,
  parseOutcome,
  parseRevise,
  parseSend,
  type FieldErrors,
  type Parsed,
} from '@/components/p2/quotations/forms';
import { lifecyclePaths } from '@/components/p2/quotations/lifecycle-contract';
import { ApiError, apiFetch } from '@/lib/api';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import type { Session } from '@/lib/session';

/**
 * Send, record the outcome and revise. Serves the NFR "no double sends, no double decisions": each
 * form carries an Idempotency-Key that the page generated once per render, and `expectedVersion`,
 * the `version` of the version row the person actually looked at, so a stale click is refused with
 * 409 instead of acting on information that has moved.
 *
 * The three endpoints have no response schema in the contracts yet and none of these actions needs
 * the body, so success is "the API answered 2xx". Send and outcome return `done`: the dialog then
 * says so and reloads the page when it is closed. Revise redirects to the edit page.
 */

export interface ActionState {
  /** The key the next submit will use. Rotated after a definite refusal, kept after an unknown outcome. */
  key: string;
  error?: string;
  /** Set when the page is out of date and the person should reload it. */
  reload?: boolean;
  /** One sentence per wrong field; the request never reached the API. */
  errors?: FieldErrors;
  /** The API accepted the request. */
  done?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** POSTs a JSON body. These endpoints answer with a body this file does not need, so only `ok` is read. */
async function post(session: Session, path: string, body: unknown, key: string): Promise<void> {
  const res = await apiFetch(session, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const raw = await res.text();
  let parsed: unknown = raw === '' ? undefined : raw;
  try {
    if (raw !== '') parsed = JSON.parse(raw) as unknown;
  } catch {
    // Not JSON (a proxy's HTML page, say): keep the text; `failureOf` words it by status.
  }
  throw new ApiError(
    res.status,
    `POST ${path.split('?')[0] ?? path} failed with ${res.status}`,
    parsed,
  );
}

const BROKEN: Pick<ActionState, 'error' | 'reload'> = {
  error: 'This form is incomplete. Reload the page.',
  reload: true,
};

/**
 * What every action does first: check the ids, take the page's key, and parse the form. Returns the
 * state to show when the form cannot go further, `null` once it can. Validation failures never reach
 * the API, so the same key is still unused.
 */
async function run<B>(
  prev: ActionState,
  form: FormData,
  parse: (form: FormData) => Parsed<B>,
  send: (
    ctx: { session: Session; quotationId: string; versionId: string; body: B },
    key: string,
  ) => Promise<void>,
): Promise<ActionState> {
  const quotationId = text(form, 'quotationId');
  const versionId = text(form, 'versionId');
  if (!UUID.test(quotationId) || !UUID.test(versionId)) return { key: prev.key, ...BROKEN };

  const session = await requireStaffSession(`/quotations/${quotationId}`);
  const submitted = text(form, 'idempotencyKey');
  const key = KEY.test(submitted) ? submitted : randomUUID();

  const parsed = parse(form);
  if (!parsed.ok) {
    const { form: broken, ...fields } = parsed.errors;
    return broken !== undefined
      ? { key, error: broken, reload: true, errors: fields }
      : { key, errors: fields };
  }

  try {
    await send({ session, quotationId, versionId, body: parsed.body }, key);
  } catch (err) {
    const failure = failureOf(err);
    return {
      // A 4xx is a final answer (this click is over), so the next try is a new decision. After a
      // timeout or 5xx the first call may have landed: send the same key so it cannot apply twice.
      key: failure.definite ? randomUUID() : key,
      error: failure.message,
      ...(failure.reload ? { reload: true } : {}),
    };
  }
  return { key, done: true };
}

const q = (id: string): string => `/v1/quotations/${encodeURIComponent(id)}`;

/** `POST /v1/quotations/:id/versions/:vid/send`: the customer gets an email with a portal link. */
export async function sendAction(prev: ActionState, form: FormData): Promise<ActionState> {
  return run(prev, form, parseSend, (c, key) =>
    post(
      c.session,
      `${q(c.quotationId)}/versions/${encodeURIComponent(c.versionId)}/send`,
      c.body,
      key,
    ),
  );
}

/** `POST /v1/quotations/:id/versions/:vid/outcome`: the customer's answer, with its evidence kinds. */
export async function outcomeAction(prev: ActionState, form: FormData): Promise<ActionState> {
  return run(
    prev,
    form,
    (f) => parseOutcome(f, kathmanduToday()),
    (c, key) =>
      post(
        c.session,
        `${q(c.quotationId)}/versions/${encodeURIComponent(c.versionId)}/outcome`,
        c.body,
        key,
      ),
  );
}

/** `POST /v1/quotations/:id/revise`: a new draft revision, then straight to editing it. */
export async function reviseAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await run(prev, form, parseRevise, (c, key) =>
    post(c.session, `${q(c.quotationId)}/revise`, c.body, key),
  );
  if (state.done !== true) return state;
  const quotationId = text(form, 'quotationId');
  revalidatePath(`/quotations/${quotationId}`);
  // `redirect` throws, so it stays outside any try block.
  redirect(`/quotations/${encodeURIComponent(quotationId)}/edit`);
}

/**
 * Cancel quotation: ends a Draft or Returned quotation, with a mandatory reason. The path and body are
 * the ones `lifecycle-contract.ts` names. The dialog says it is done and reloads the page when closed.
 */
export async function cancelAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await run(prev, form, parseCancel, (c, key) =>
    post(c.session, lifecyclePaths.cancel(c.quotationId), c.body, key),
  );
  if (state.done === true) {
    revalidatePath(`/quotations/${text(form, 'quotationId')}`);
    revalidatePath('/quotations');
  }
  return state;
}

/**
 * Confirm acceptance evidence (F1-Q28): a staff member records that the customer's evidence for an
 * accepted revision was checked. Path and body: `lifecycle-contract.ts`.
 */
export async function confirmAcceptanceAction(
  prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const state = await run(prev, form, parseConfirmAcceptance, (c, key) =>
    post(c.session, lifecyclePaths.confirmAcceptance(c.quotationId, c.versionId), c.body, key),
  );
  if (state.done === true) revalidatePath(`/quotations/${text(form, 'quotationId')}`);
  return state;
}
