import type { PaymentReferenceMatch } from '@/lib/api-payments';

/** The fields the Record payment form can name in an error. `proof` is the proof-file list. */
export type RecordPaymentField =
  | 'customerId'
  | 'currency'
  | 'amount'
  | 'method'
  | 'receivedOn'
  | 'bankReference'
  | 'tdsWithheld'
  | 'withholdingCode'
  | 'proof';

/** What the record action hands back to its form. */
export interface RecordPaymentState {
  /** The key the next submit will use. Rotated after a definite refusal, kept after an unknown outcome. */
  key: string;
  /** A refusal that is not about one field: 403, 422 invalid proof, 409 or a lost connection. */
  error?: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload?: boolean;
  /** Words per wrong field; the request never reached the API. */
  fieldErrors?: Partial<Record<RecordPaymentField, string>>;
  /**
   * Earlier payments with the same bank reference that the person has not yet said are different.
   * Nothing was recorded; ticking the confirm box and pressing Record payment again records it.
   */
  referenceMatches?: PaymentReferenceMatch[];
}

// Words the record action and its tests share. They live here because a 'use server' file may export only async functions.
export const NO_RECORD_WORDS =
  'Your roles do not include recording payments. Ask an administrator if you need to.';

export const INVALID_PROOF_MESSAGE =
  'A proof file is not ready yet. Files are checked for viruses before a payment can use them. Wait a moment, then press Record payment again. If it keeps happening, remove the file and add it again.';

export const NOT_FOUND_MESSAGE =
  'We could not find that customer. Reload the page and choose the customer again.';

export const STALE_MESSAGE =
  'The platform could not record this payment because something changed. Reload the page and try again.';

export const UNKNOWN_CODE_MESSAGE =
  'The platform does not know that withholding code. Check it against the tax certificate.';
