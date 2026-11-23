import { ErrorBodySchema } from '@bos/contracts';

import { ApiError } from '@/lib/api';
import { isIdempotencyInProgress } from '@/components/p2/quote-builder/failure';

/**
 * Words for every refusal the vendor screens can get. The kernel's `describeFailure` speaks of
 * "this document" and "this customer", which is wrong here: a 403 on activate means the person
 * created the vendor, a 403 on verify means they proposed the bank account, and a 409 on activate
 * means no approved KYB case. So the wording is keyed on what the person was trying to do.
 * Pure apart from the `ApiError` class; the API's own text is shown only for a 400, where it names
 * fields and never values.
 */

export type VendorOp =
  | 'load'
  | 'create'
  | 'edit'
  | 'contact'
  | 'submitKyc'
  | 'activate'
  | 'lifecycle'
  | 'propose'
  | 'verify'
  | 'reject'
  | 'upload'
  | 'grant';

export interface VendorFailure {
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

function forbidden(reason: string | undefined, op: VendorOp): string {
  if (reason === 'separation_of_duties') {
    if (op === 'activate') {
      return 'You created this vendor, so someone else must activate it. Ask a colleague who can approve vendors.';
    }
    if (op === 'verify') {
      return 'You proposed this bank account, so someone else must verify it. Ask a colleague in finance.';
    }
    return "You can't do this on a record you created. Ask a colleague to do it.";
  }
  if (reason === 'out_of_scope') return 'This vendor belongs to an area you cannot access.';
  if (reason === 'mfa_required') {
    return 'This action needs a second sign-in step (MFA). Sign in again with it, then retry.';
  }
  if (reason === 'inactive_user') {
    return 'Your account is not active. Ask an administrator to restore it.';
  }
  return 'Your roles do not allow this. Ask an administrator if you need it.';
}

function notFound(op: VendorOp): string {
  return op === 'verify' || op === 'reject' || op === 'upload'
    ? 'We could not find that bank account. It may have been removed.'
    : 'We could not find that vendor. It may have been removed.';
}

/** A 409 with a code the API names. `reload` is true only when the page really is out of date. */
function conflict(
  code: string | undefined,
  op: VendorOp,
): { message: string; reload: boolean } | undefined {
  switch (code) {
    case 'kyb_not_verified':
      return {
        message:
          'This vendor has no approved KYB case yet. Finish the KYB review first, then activate the vendor.',
        reload: false,
      };
    case 'kyc_expired':
      return {
        message:
          'A KYC document, such as the tax clearance, has expired. Renew it in the KYB case, then try again.',
        reload: false,
      };
    case 'kyb_not_submitted':
      return {
        message:
          'The KYB case has not been submitted yet. Submit it for review in the KYB case, then send the vendor for review.',
        reload: false,
      };
    case 'duplicate_pan_vat':
      return { message: 'Another vendor already has this PAN.', reload: false };
    case 'vendor_identity_locked':
      return {
        message:
          'The legal name, PAN, kind and country of an approved or suspended vendor cannot be edited.',
        reload: false,
      };
    case 'vendor_not_editable':
      return { message: "A blocked or archived vendor can't be edited.", reload: false };
    case 'callback_evidence_not_clean':
      return {
        message:
          'The call-back evidence must be a file for this account whose virus scan came back clean. Upload it again and wait for the scan.',
        reload: false,
      };
    case 'account_exists':
      return {
        message: 'This vendor already has an account with that legal entity.',
        reload: false,
      };
    case 'primary_contact_exists':
      return { message: 'This vendor already has a main contact.', reload: false };
    case 'invalid_transition':
      if (op === 'grant') {
        return {
          message:
            'Portal access needs an approved vendor, or one that is waiting for KYC. This vendor is in another status.',
          reload: true,
        };
      }
      if (op === 'verify' || op === 'reject') {
        return {
          message: 'This bank account has already been decided. Reload to see where it stands.',
          reload: true,
        };
      }
      return {
        message:
          "This vendor's status does not allow that action. Reload to see its current status.",
        reload: true,
      };
    default:
      return undefined;
  }
}

/** Turns anything a vendor action or page caught into words, a reload flag and the key rule. */
export function vendorFailure(err: unknown, op: VendorOp): VendorFailure {
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
  if (status === 403) return { ...base, message: forbidden(reason, op), definite };
  if (status === 404) return { ...base, message: notFound(op), definite };
  if (status === 409) {
    const named = conflict(code, op);
    if (named !== undefined) return { ...named, status, definite };
    return {
      status,
      message: 'This vendor changed since you opened it. Reload and try again.',
      reload: true,
      definite,
    };
  }
  if (status === 400) {
    if (code === 'contact_email_missing') {
      return {
        ...base,
        message:
          'This contact has no email address, so the portal invite cannot be sent. Add an email to the contact first.',
        definite,
      };
    }
    return {
      ...base,
      message:
        message !== undefined && message !== ''
          ? `The platform did not accept this: ${message}`
          : 'The platform did not accept this request. Check what you entered and try again.',
      definite,
    };
  }
  if (status === 413) return { ...base, message: 'That file is larger than 25 MB.', definite };
  if (status === 415) {
    return {
      ...base,
      message:
        'That file type is not accepted. Use PDF, PNG, JPEG, WebP, Word, Excel, PowerPoint or CSV.',
      definite,
    };
  }
  if (status === 503 && code === 'idp_not_configured') {
    return {
      ...base,
      message:
        'The sign-in service is not set up for portal invitations yet. Nothing was changed; ask an administrator.',
      definite: false,
    };
  }
  return { ...base, message: DID_NOT_RESPOND, definite: false };
}
