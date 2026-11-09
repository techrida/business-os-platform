import type { FieldErrors } from './lines';

/** What the manual invoice, credit note and debit note actions hand back to their forms. */
export interface InvoiceFormState {
  /** The Idempotency-Key the next submit sends: kept after an unknown outcome, new after a final answer. */
  key: string;
  /** One sentence per wrong field; the request never reached the API. */
  errors: FieldErrors;
  /** A refusal that is not about one field: 403, 409, 422, 5xx or a lost connection. */
  error?: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload?: boolean;
}
