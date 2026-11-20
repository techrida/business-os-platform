'use server';

import { randomUUID } from 'node:crypto';

import {
  CreateQuotationBodySchema,
  QuotationPreviewBodySchema,
  UpdateQuotationDraftBodySchema,
} from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { ApiError } from '@/lib/api';
import { requireStaffSession } from '@/lib/bff';

import * as api from './api';
import { describeQuoteFailure, isIdempotencyInProgress, type FailureKind } from './failure';
import { scheduleMessage, scheduleState, toContent, type BuilderValues } from './model';
import type { PreviewResult } from './schemas';

/**
 * Server actions of the quote builder. The browser sends what the user typed; every action
 * re-validates it against the contracts (the client checks are a courtesy), then calls the API
 * with the session's token. None of them returns or computes a total: totals come from the
 * preview endpoint, untouched.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INCOMPLETE = 'This form is incomplete. Reload the page.';
/** The page's key is a UUID; anything else was tampered with or lost, so a fresh one is used. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

export type ActionFailure = {
  ok: false;
  kind: FailureKind;
  message: string;
  /** Field path (for example `lines.0.quantity`) to a short message, when the cause is a field. */
  fieldErrors?: Record<string, string>;
  /**
   * The Idempotency-Key the next try must send, on the actions that take one. The same key when the
   * request never reached the API or its outcome is unknown (timeout, 5xx), a new one after a definite
   * refusal (4xx), so a retry can never apply twice and a new decision is never mistaken for a retry.
   */
  key?: string;
};

const keyOf = (submitted: string): string => (KEY.test(submitted) ? submitted : randomUUID());

/**
 * A 4xx is a final answer, so the next click is a new request; anything else may have landed. The one
 * 4xx that is not final is the 409 saying the first request with this key is still being processed:
 * a new key there would make the retry a second request and could create a duplicate.
 */
const nextKey = (err: unknown, key: string): string =>
  err instanceof ApiError && err.status >= 400 && err.status < 500 && !isIdempotencyInProgress(err)
    ? randomUUID()
    : key;

interface Ref {
  quotationId: string;
  versionId: string;
}

const refOk = (r: Ref): boolean => UUID.test(r.quotationId) && UUID.test(r.versionId);

function issuesToFields(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const i of issues) out[i.path.join('.')] ??= i.message;
  return out;
}

const invalid = (message: string, fieldErrors?: Record<string, string>): ActionFailure => ({
  ok: false,
  kind: 'invalid',
  message,
  ...(fieldErrors ? { fieldErrors } : {}),
});

/** One place for the "payment schedule must total 100%" rule, so save and submit both stop on it. */
function scheduleFailure(values: BuilderValues): ActionFailure | null {
  const msg = scheduleMessage(scheduleState(values.schedule));
  return msg ? invalid(msg, { paymentSchedule: msg }) : null;
}

// ---------------------------------------------------------------------------------------------
// Preview: totals and approval route, from the server
// ---------------------------------------------------------------------------------------------

export async function previewQuoteAction(input: {
  quotationId: string;
  versionId: string;
  values: BuilderValues;
}): Promise<{ ok: true; preview: PreviewResult } | ActionFailure> {
  if (!refOk(input)) return invalid(INCOMPLETE);
  const session = await requireStaffSession(`/quotations/${input.quotationId}/edit`);

  const content = toContent(input.values);
  const parsed = QuotationPreviewBodySchema.safeParse({
    currency: content.currency,
    ...(content.discount ? { discount: content.discount } : {}),
    lines: content.lines,
  });
  if (!parsed.success) {
    return invalid(
      'Complete every line (description, unit, quantity, rate and tax code) to see the totals.',
      issuesToFields(parsed.error.issues),
    );
  }
  try {
    const preview = await api.previewVersion(
      session,
      input.quotationId,
      input.versionId,
      parsed.data,
    );
    return { ok: true, preview };
  } catch (err) {
    const f = describeQuoteFailure(err, 'preview');
    return { ok: false, kind: f.kind, message: f.message };
  }
}

// ---------------------------------------------------------------------------------------------
// Save the draft (explicit)
// ---------------------------------------------------------------------------------------------

export type SaveInput =
  | { mode: 'create'; opportunityId: string; idempotencyKey: string; values: BuilderValues }
  | (Ref & { mode: 'update'; expectedVersion: number; values: BuilderValues });

export async function saveDraftAction(
  input: SaveInput,
): Promise<{ ok: true; version: number } | ActionFailure> {
  const returnTo =
    input.mode === 'create'
      ? `/quotations/new?opportunityId=${encodeURIComponent(input.opportunityId)}`
      : `/quotations/${input.quotationId}/edit`;
  if (input.mode === 'create' ? !UUID.test(input.opportunityId) : !refOk(input)) {
    return invalid(INCOMPLETE);
  }
  const session = await requireStaffSession(returnTo);
  // Only a create takes a key; an update is guarded by expectedVersion instead.
  const key = input.mode === 'create' ? keyOf(input.idempotencyKey) : '';
  const withKey = (f: ActionFailure): ActionFailure => (key === '' ? f : { ...f, key });

  const blocked = scheduleFailure(input.values);
  if (blocked) return withKey(blocked);

  const content = toContent(input.values, input.mode);

  if (input.mode === 'create') {
    const parsed = CreateQuotationBodySchema.safeParse({
      ...content,
      opportunityId: input.opportunityId,
    });
    if (!parsed.success) {
      return withKey(
        invalid(
          'Some fields need attention before this can be saved.',
          issuesToFields(parsed.error.issues),
        ),
      );
    }
    let id: string;
    try {
      id = (await api.createQuotation(session, parsed.data, key)).id;
    } catch (err) {
      const f = describeQuoteFailure(err, 'save');
      return { ok: false, kind: f.kind, message: f.message, key: nextKey(err, key) };
    }
    revalidatePath('/quotations');
    redirect(`/quotations/${id}/edit?saved=1`);
  }

  const parsed = UpdateQuotationDraftBodySchema.safeParse({
    ...content,
    expectedVersion: input.expectedVersion,
  });
  if (!parsed.success) {
    return invalid(
      'Some fields need attention before this can be saved.',
      issuesToFields(parsed.error.issues),
    );
  }
  try {
    const saved = await api.updateDraft(session, input.quotationId, input.versionId, parsed.data);
    revalidatePath(`/quotations/${input.quotationId}/edit`);
    return { ok: true, version: saved.version };
  } catch (err) {
    const f = describeQuoteFailure(err, 'save');
    return { ok: false, kind: f.kind, message: f.message };
  }
}

// ---------------------------------------------------------------------------------------------
// Submit for approval
// ---------------------------------------------------------------------------------------------

export async function submitQuoteAction(
  input: Ref & {
    expectedVersion: number;
    idempotencyKey: string;
    values: BuilderValues;
    /** The person chosen to decide the first approval step; absent for "anyone eligible". */
    approverUserId?: string | undefined;
  },
): Promise<{ ok: true } | ActionFailure> {
  if (!refOk(input)) return invalid(INCOMPLETE);
  const approver = input.approverUserId === '' ? undefined : input.approverUserId;
  if (approver !== undefined && !z.guid().safeParse(approver).success) {
    return invalid('Choose the approver again.');
  }
  const session = await requireStaffSession(`/quotations/${input.quotationId}/edit`);
  const key = keyOf(input.idempotencyKey);

  // Blocked here, before any call: a schedule that does not total 100% never reaches the API.
  const blocked = scheduleFailure(input.values);
  if (blocked) return { ...blocked, key };

  try {
    await api.submitVersion(
      session,
      input.quotationId,
      input.versionId,
      input.expectedVersion,
      key,
      approver,
    );
  } catch (err) {
    const f = describeQuoteFailure(err, 'submit');
    return {
      ok: false,
      kind: f.kind,
      message: f.message,
      ...(f.field ? { fieldErrors: { [f.field]: f.message } } : {}),
      key: nextKey(err, key),
    };
  }
  revalidatePath(`/quotations/${input.quotationId}/edit`);
  return { ok: true };
}
