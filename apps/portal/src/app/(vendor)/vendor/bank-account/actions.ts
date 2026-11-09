'use server';

import { randomUUID } from 'node:crypto';

import { VendorBankChangeRequestBodySchema } from '@bos/contracts';

import { requestVendorBankChange } from '@/lib/api.vendor-writes';

import {
  failed,
  type FormState,
  keyOf,
  NOT_A_VENDOR,
  text,
  vendorSession,
} from '../_upload/action-kit';

/**
 * Ask to change the bank account we pay the vendor into. It only proposes: staff verify the
 * account before it is used. The account number goes from the form to the API and nowhere else:
 * no state this action returns, no error, no redirect and no log line holds it, and the only
 * thing shown back is the bank name and the last four digits the API answers with. The form
 * carries an Idempotency-Key the page generated once per render and rotates it after a success,
 * so a double click or a retry after a timeout records the request once. The vendor comes from
 * the signed-in user (the body has no party or vendor id); server actions run no layout, so this
 * checks for itself that the session is a vendor's.
 */

export type BankField =
  'bankName' | 'branch' | 'accountName' | 'accountNumber' | 'confirmAccountNumber' | 'swift';

export interface BankFormState extends FormState<BankField> {
  /** Set after the request was recorded: what the page may say about it. Never the number. */
  received?: { bankName: string | null; last4: string | null };
}

const HERE = '/vendor/bank-account';

const FIELD_MESSAGE: Record<BankField, string> = {
  bankName: 'Enter the name of the bank (up to 120 characters).',
  branch: 'The branch can be up to 120 characters.',
  accountName: 'Enter the name the account is held in (up to 160 characters).',
  accountNumber: 'Enter the account number: 6 to 34 letters, digits or hyphens, without spaces.',
  confirmAccountNumber: 'The two account numbers are not the same. Type the number again.',
  swift: 'A SWIFT code has 8 or 11 letters and digits. Leave it empty if you do not have one.',
};

export async function requestBankChangeAction(
  prev: BankFormState,
  form: FormData,
): Promise<BankFormState> {
  const session = await vendorSession(HERE);
  const key = keyOf(form, prev);
  if (!session) return { key, error: NOT_A_VENDOR };

  // People copy numbers with spaces from a statement; the API strips them too.
  const accountNumber = text(form, 'accountNumber').replace(/\s/g, '');
  const confirmation = text(form, 'confirmAccountNumber').replace(/\s/g, '');
  const branch = text(form, 'branch').trim();
  const swift = text(form, 'swift').replace(/\s/g, '');
  const candidate = {
    bankName: text(form, 'bankName').trim(),
    accountName: text(form, 'accountName').trim(),
    accountNumber,
    ...(branch === '' ? {} : { branch }),
    ...(swift === '' ? {} : { swift }),
  };

  const parsed = VendorBankChangeRequestBodySchema.safeParse(candidate);
  const fieldErrors: Partial<Record<BankField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as BankField | undefined;
      if (field !== undefined && field in FIELD_MESSAGE) fieldErrors[field] = FIELD_MESSAGE[field];
    }
  }
  if (parsed.success && confirmation !== accountNumber) {
    fieldErrors.confirmAccountNumber = FIELD_MESSAGE.confirmAccountNumber;
  }
  if (!parsed.success || fieldErrors.confirmAccountNumber !== undefined) {
    // Nothing reached the API, so the same key is still unused.
    return { key, fieldErrors };
  }

  try {
    const receipt = await requestVendorBankChange(session, parsed.data, key);
    return {
      key: randomUUID(),
      received: { bankName: receipt?.bankName ?? null, last4: receipt?.last4 ?? null },
    };
  } catch (err) {
    return failed<BankField>(err, key, HERE, {
      noun: 'bank account request',
      forbidden:
        'Your account cannot change bank details right now. Please contact the person you work with at our company.',
    });
  }
}
