import { ErrorBodySchema } from '@bos/contracts';

import { isIdempotencyInProgress } from '@/components/p2/quote-builder/failure';
import { ApiError } from '@/lib/api';
import { infectedFileMessage } from '@/lib/infected-file';

/**
 * The shared part of the words for the purchase order and receipt screens. Pure apart from the
 * `ApiError` class. The API's own text is shown only for a 400 (it names fields, never values);
 * every other refusal is worded here, keyed on the code and on what the person was trying to do.
 */

export interface ProcFailure {
  message: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload: boolean;
  /**
   * True for a final answer (a 4xx other than the in-progress 409, 408 and 429): the next try is a
   * new decision and gets a new Idempotency-Key. False means the first call may have landed, so
   * the same key goes again.
   */
  definite: boolean;
  status: number;
}

export const DID_NOT_RESPOND =
  'The platform did not respond. Nothing was lost; try again in a moment.';

export interface Words {
  notFound: string;
  /** Said for a 403 with no better reason. */
  noPermission: string;
  /** The words for a 409 the API names, or undefined to fall back. */
  conflict: (code: string | undefined) => { message: string; reload: boolean } | undefined;
  /** A 409 nobody named: the record moved, or something else is open on it. */
  conflictFallback: string;
  /** The words for a 422 the API names. */
  unprocessable: (code: string | undefined) => string | undefined;
}

function fieldsOf(err: ApiError): {
  code?: string | undefined;
  reason?: string | undefined;
  message?: string | undefined;
} {
  const parsed = ErrorBodySchema.safeParse(err.body);
  if (!parsed.success) return {};
  const e = parsed.data.error;
  return { code: e.code, reason: e.reason, message: e.message };
}

function forbidden(reason: string | undefined, noPermission: string): string {
  if (reason === 'separation_of_duties') {
    return "You can't do this on a record you created. Ask a colleague to do it.";
  }
  if (reason === 'out_of_scope') return 'This record belongs to an area you cannot access.';
  if (reason === 'mfa_required') {
    return 'This action needs a second sign-in step (MFA). Sign in again with it, then retry.';
  }
  if (reason === 'inactive_user') {
    return 'Your account is not active. Ask an administrator to restore it.';
  }
  return noPermission;
}

/** Turns anything an action or page caught into words, a reload flag and the key rule. */
export function failureWith(err: unknown, words: Words): ProcFailure {
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
  if (status === 403) {
    return { ...base, message: forbidden(reason, words.noPermission), definite };
  }
  if (status === 404) return { ...base, message: words.notFound, definite };
  if (status === 409) {
    const infected = infectedFileMessage(err);
    if (infected !== undefined) return { ...base, message: infected, definite };
    const named = words.conflict(code);
    if (named !== undefined) return { ...named, status, definite };
    return { status, message: words.conflictFallback, reload: true, definite };
  }
  if (status === 422) {
    const named = words.unprocessable(code);
    if (named !== undefined) return { ...base, message: named, definite };
    return {
      ...base,
      message: 'The platform did not accept this request. Check what you entered and try again.',
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
