// Turns an API failure into words and a kind the builder can act on. Pure (no server-only import),
// so it can be tested and used from the actions.

export type FailureKind =
  | 'stale' // the row version moved: reload
  | 'stale_fx' // the exchange rate is older than the allowed window
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'session'
  | 'error';

export interface QuoteFailure {
  kind: FailureKind;
  message: string;
}

interface ErrorLike {
  status: number;
  body?: unknown;
}

interface Fields {
  code: string;
  message: string;
  reason: string;
  details: Record<string, unknown>;
}

function errorFields(body: unknown): Fields {
  const e = (body as { error?: Record<string, unknown> } | null | undefined)?.error;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const d = e?.details;
  const details =
    typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  return { code: s(e?.code), message: s(e?.message), reason: s(e?.reason), details };
}

const FORBIDDEN: Record<string, string> = {
  separation_of_duties: 'You prepared this quotation, so you cannot approve it.',
  no_permission: "Your roles don't allow this. Ask an administrator if you need it.",
  out_of_scope: 'This quotation belongs to an area you cannot access.',
  mfa_required: 'This action needs a second sign-in step (MFA). Sign in again with it, then retry.',
  inactive_user: 'Your account is not active. Ask an administrator to restore it.',
};

export const STALE_FX_MESSAGE =
  'The exchange rate for this currency is older than 7 days, so the quotation cannot be priced or submitted. Ask Finance to enter today’s rate, then try again. Your changes are still here.';

export const STALE_VERSION_MESSAGE =
  'Someone else changed this quotation after you opened it. Reload to see the latest version. Your unsaved edits on this page will be lost, so copy anything you need first.';

export const NO_APPROVER_MESSAGE =
  'No one can approve this right now. Ask an admin to check the approvers for this route.';

export const NO_WORKFLOW_MESSAGE = "Approvals for quotations aren't set up yet. Ask an admin.";

export const STILL_SAVING_MESSAGE = 'Still saving — wait a moment and try again.';

export const DIFFERENT_CONTENT_MESSAGE =
  'This was already submitted with different content. Reload and try again.';

/** A 409 about the exchange rate, told apart from a stale row version by the API's code or text. */
function isFxConflict(f: Pick<Fields, 'code' | 'message'>): boolean {
  return /fx|exchange|rate_stale|stale_rate/i.test(`${f.code} ${f.message}`);
}

/** The API's idempotency guard (platform/db/idempotency.ts) names the header in its message. */
function isIdempotency(f: Pick<Fields, 'message'>): boolean {
  return /idempotency-key/i.test(f.message);
}

/**
 * True for the 409s that say the first request with this Idempotency-Key has not settled yet (the API's
 * code for both is the generic `conflict`; only the message names the header). The next try must send
 * the same key so it replays that request instead of starting a second one.
 */
export function isIdempotencyInProgress(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if (Number((err as ErrorLike).status) !== 409) return false;
  return isIdempotency(errorFields((err as ErrorLike).body));
}

const CURRENCY = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The stale-rate sentence, naming the currency and the date of the newest rate when the API sent
 * them. Only a three-letter code and a plain date are echoed, so nothing else in `details` can
 * reach the screen.
 */
function staleFxMessage(details: Record<string, unknown>): string {
  const currency =
    typeof details.currency === 'string' && CURRENCY.test(details.currency)
      ? details.currency
      : undefined;
  const rateDate =
    typeof details.rateDate === 'string' && DAY.test(details.rateDate)
      ? details.rateDate
      : undefined;
  const maxAge =
    typeof details.maxAgeDays === 'number' && Number.isInteger(details.maxAgeDays)
      ? details.maxAgeDays
      : undefined;
  if (currency === undefined && rateDate === undefined) return STALE_FX_MESSAGE;
  const what = currency !== undefined ? `The ${currency} exchange rate` : 'The exchange rate';
  const from = rateDate !== undefined ? ` on file is from ${rateDate}` : '';
  const limit = maxAge !== undefined ? `, more than ${maxAge} days old` : ', which is too old';
  return `${what}${from}${rateDate !== undefined ? limit : ' is too old'}, so the quotation cannot be priced or submitted. Ask Finance to enter today’s rate, then try again. Your changes are still here.`;
}

/** The API answers 409 `conflict` "No NPR rate for USD on or before ..." when no rate exists at all. */
function missingRateCurrency(message: string): string | undefined {
  return /^No NPR rate for ([A-Z]{3})\b/.exec(message)?.[1];
}

export function describeQuoteFailure(
  err: unknown,
  action: 'save' | 'preview' | 'submit' | 'load',
): QuoteFailure {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as ErrorLike).status)
      : 0;
  const f = errorFields((err as ErrorLike | null)?.body);

  if (status === 401) {
    return { kind: 'session', message: 'Your session ended. Sign in again to continue.' };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      message: FORBIDDEN[f.reason] ?? "You don't have permission to do this.",
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: 'We could not find this quotation. It may have been removed.',
    };
  }
  if (status === 409) {
    if (isIdempotency(f)) return { kind: 'error', message: STILL_SAVING_MESSAGE };
    if (isFxConflict(f)) return { kind: 'stale_fx', message: staleFxMessage(f.details) };
    const missing = missingRateCurrency(f.message);
    if (missing !== undefined) {
      return {
        kind: 'stale_fx',
        message: `There is no exchange rate for ${missing} yet, so the quotation cannot be priced or submitted. Ask Finance to enter one, then try again. Your changes are still here.`,
      };
    }
    if (/no published approval workflow/i.test(f.message)) {
      return { kind: 'error', message: NO_WORKFLOW_MESSAGE };
    }
    return { kind: 'stale', message: STALE_VERSION_MESSAGE };
  }
  if (status === 422 && f.code === 'NO_ELIGIBLE_APPROVER') {
    return { kind: 'error', message: NO_APPROVER_MESSAGE };
  }
  if (status === 422 && f.code === 'APPROVER_NOT_ELIGIBLE') {
    // The API's sentence says why (the author themselves, or someone who cannot approve this quotation).
    return {
      kind: 'error',
      message:
        f.message !== ''
          ? `${f.message} Nothing was submitted.`
          : 'The chosen approver cannot approve this quotation. Choose someone else. Nothing was submitted.',
    };
  }
  if (status === 422 && isIdempotency(f)) {
    return { kind: 'error', message: DIFFERENT_CONTENT_MESSAGE };
  }
  if (status === 400 || status === 422) {
    return {
      kind: 'invalid',
      message:
        status === 400 && f.message !== ''
          ? `The platform did not accept this: ${f.message}`
          : 'The platform did not accept this quotation. Check the highlighted fields and try again.',
    };
  }
  const what: Record<typeof action, string> = {
    preview: 'The totals could not be worked out',
    submit: 'Nothing was submitted',
    save: 'Nothing was saved',
    load: 'This page could not be loaded',
  };
  return {
    kind: 'error',
    message: `The platform did not respond. ${what[action]}; try again in a moment.`,
  };
}
