import { ErrorBodySchema } from '@bos/contracts';

import { isIdempotencyInProgress } from '@/components/p2/quote-builder/failure';
import { ApiError } from '@/lib/api';
import { currencyNotEnabledText } from '@/lib/kernel-ui';
import { infectedFileMessage } from '@/lib/infected-file';

import type { PrFailure } from '../../requests/_lib/failure';

/**
 * Words for every refusal the RFQ screens can get. The purchase request mapper says "purchase
 * request" on a 404 and "reload" on every 409; here a 409 is usually a domain answer written for
 * people (a vendor not approved, not invited, already quoted, a scan that has not passed), so the
 * API's own sentence is shown. Same key rule as everywhere: a definite answer (a 4xx other than the
 * in-progress 409, 408 and 429) rotates the Idempotency-Key; a timeout, a 5xx or the in-progress
 * 409 keeps it.
 */

export type RfqOp = 'load' | 'create' | 'record' | 'convert' | 'score' | 'recommend' | 'commit';
export type RfqFailure = PrFailure;

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
  if (reason === 'out_of_scope') return 'This RFQ belongs to an area you cannot access.';
  if (reason === 'mfa_required') {
    return 'This action needs a second sign-in step (MFA). Sign in again with it, then retry.';
  }
  if (reason === 'inactive_user') {
    return 'Your account is not active. Ask an administrator to restore it.';
  }
  return 'Your roles do not allow this. Ask an administrator if you need it.';
}

const NOT_FOUND: Record<RfqOp, string> = {
  load: 'We could not find that RFQ. It may have been removed, or it belongs to another entity.',
  create: 'We could not find that purchase request in this entity.',
  record: 'We could not find that RFQ.',
  convert: 'We could not find that RFQ or that vendor submission.',
  score: 'We could not find that RFQ or quotation.',
  recommend: 'We could not find that RFQ.',
  commit: 'We could not find that RFQ.',
};

const STALE =
  'This RFQ changed since you opened it. Reload to see where it stands, then try again.';

/** The API refused an RFQ because its quotation deadline is not after now (400 `deadline_in_past`). */
export function isDeadlineInPast(err: unknown): boolean {
  return (
    err instanceof ApiError && err.status === 400 && fieldsOf(err).reason === 'deadline_in_past'
  );
}

/** Turns anything an RFQ action or page caught into words, a reload flag and the key rule. */
export function rfqFailure(err: unknown, op: RfqOp): RfqFailure {
  if (!(err instanceof ApiError)) {
    return { message: DID_NOT_RESPOND, reload: false, definite: false, status: 0 };
  }
  const { status } = err;
  const { code, reason, message } = fieldsOf(err);
  const text = message !== undefined && message !== '' ? message : undefined;
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
  if (status === 404) return { ...base, message: NOT_FOUND[op], definite };
  if (status === 409) {
    const infected = infectedFileMessage(err);
    if (infected !== undefined) return { ...base, message: infected, definite };
    if (code === 'FEWER_THAN_MIN_QUOTES') {
      return {
        status,
        message:
          'There are fewer quotations than the minimum. Say why you are recommending one anyway, then try again.',
        reload: false,
        definite,
      };
    }
    return { status, message: text ?? STALE, reload: true, definite };
  }
  if (status === 422) {
    // U16-Q14: the agreed D44 words for a currency the company switched off, not the API's sentence.
    const switchedOff = currencyNotEnabledText(err);
    if (switchedOff !== undefined) return { ...base, message: switchedOff, definite };
    if (code === 'NO_ELIGIBLE_APPROVER') {
      return {
        ...base,
        message: `${text ?? 'Nobody is able to approve this commitment.'} Nothing was submitted. Ask an administrator to fix the approvers, then try again.`,
        definite,
      };
    }
    return {
      ...base,
      message: text ?? 'The platform could not accept this as it stands.',
      definite,
    };
  }
  if (status === 400) {
    return {
      ...base,
      message:
        text !== undefined
          ? `The platform did not accept this: ${text}`
          : 'The platform did not accept this. Check what you entered and try again.',
      definite,
    };
  }
  return { ...base, message: DID_NOT_RESPOND, definite: false };
}
