import { ErrorBodySchema } from '@bos/contracts';

import { isIdempotencyInProgress } from '@/components/p2/quote-builder/failure';
import { ApiError } from '@/lib/api';
import { currencyNotEnabledText } from '@/lib/kernel-ui';

/**
 * Words for every refusal the purchase request screens can get. The kernel's `describeFailure`
 * answers any 422 with "the platform did not respond", which is wrong for the 422 that matters
 * here (`NO_ELIGIBLE_APPROVER`: nothing was submitted, and why), so the wording is keyed on what
 * the person was trying to do. Pure apart from the `ApiError` class; the API's own text is shown
 * for a 400 (it names fields, never values) and for the 422 (it is written for people).
 *
 * Exported for the RFQ screens, which have the same two 422/409 shapes.
 */

export type PrOp = 'load' | 'create' | 'edit' | 'submit' | 'cancel';

export interface PrFailure {
  message: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload: boolean;
  /**
   * True for a final answer (a 4xx other than the in-progress 409, 408 and 429): the next try is
   * a new decision and gets a new Idempotency-Key. False means the first call may have landed,
   * so the same key goes again.
   */
  definite: boolean;
  status: number;
}

const DID_NOT_RESPOND = 'The platform did not respond. Nothing was lost; try again in a moment.';

function fieldsOf(err: unknown): {
  code?: string | undefined;
  reason?: string | undefined;
  message?: string | undefined;
} {
  if (!(err instanceof ApiError)) return {};
  const parsed = ErrorBodySchema.safeParse(err.body);
  if (!parsed.success) return {};
  const e = parsed.data.error;
  return { code: e.code, reason: e.reason, message: e.message };
}

function forbidden(reason: string | undefined): string {
  if (reason === 'out_of_scope') return 'This request belongs to an area you cannot access.';
  if (reason === 'mfa_required') {
    return 'This action needs a second sign-in step (MFA). Sign in again with it, then retry.';
  }
  if (reason === 'inactive_user') {
    return 'Your account is not active. Ask an administrator to restore it.';
  }
  return 'Your roles do not allow this. Ask an administrator if you need it.';
}

const STALE: Record<PrOp, string> = {
  load: 'This purchase request changed since you opened it. Reload and try again.',
  create: 'This purchase request changed since you opened it. Reload and try again.',
  edit: 'This request was submitted or changed since you opened it, so it can no longer be edited here. Reload to see where it stands.',
  submit:
    'This request is no longer a draft or returned request, or it changed since you opened it. Reload to see where it stands.',
  cancel:
    'Only a draft can be cancelled, and this request is not a draft any more. Reload to see where it stands.',
};

/** Turns anything a purchase request action or page caught into words, a reload flag and the key rule. */
export function prFailure(err: unknown, op: PrOp): PrFailure {
  if (!(err instanceof ApiError)) {
    return { message: DID_NOT_RESPOND, reload: false, definite: false, status: 0 };
  }
  const { status } = err;
  const { code, reason, message } = fieldsOf(err);
  const base = { reload: false, status };

  if (status === 409 && isIdempotencyInProgress(err)) {
    return {
      ...base,
      message: 'The first attempt is still being processed. Wait a moment, then try again.',
      definite: false,
    };
  }
  const definite = status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (status === 401) {
    return { ...base, message: 'Your session ended. Sign in again to continue.', definite };
  }
  if (status === 403) return { ...base, message: forbidden(reason), definite };
  if (status === 404) {
    return {
      ...base,
      message:
        'We could not find that purchase request. It may have been removed, or it belongs to another requester.',
      definite,
    };
  }
  if (status === 409) return { status, message: STALE[op], reload: true, definite };
  if (status === 422) {
    // U16-Q14: the agreed D44 words for a currency the company switched off, not the API's sentence.
    const switchedOff = currencyNotEnabledText(err);
    if (switchedOff !== undefined) return { ...base, message: switchedOff, definite };
    const text = message !== undefined && message !== '' ? message : undefined;
    if (code === 'NO_ELIGIBLE_APPROVER') {
      return {
        ...base,
        message: `${text ?? 'Nobody is able to approve this request.'} Nothing was submitted. Ask an administrator to fix the approvers, then try again.`,
        definite,
      };
    }
    return {
      ...base,
      message: text ?? 'The platform could not accept this request as it stands.',
      definite,
    };
  }
  if (status === 400) {
    return {
      ...base,
      message:
        message !== undefined && message !== ''
          ? `The platform did not accept this: ${message}`
          : 'The platform did not accept this request. Check what you entered and try again.',
      definite,
    };
  }
  return { ...base, message: DID_NOT_RESPOND, definite: false };
}
