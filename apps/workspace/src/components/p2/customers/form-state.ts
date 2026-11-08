import type { DuplicateMatch } from './duplicate-check';
import type {
  ContactField,
  ContactValues,
  CustomerField,
  CustomerValues,
  FieldErrors,
} from './forms';

/** What the customer create and edit actions hand back to their form. */
export interface CustomerFormState {
  /** The idempotency key the next submit will use (create only). Rotated after a definite refusal. */
  key: string;
  errors: FieldErrors<CustomerField>;
  /** A refusal that is not about one field: 403, 409, 5xx or a lost connection. */
  error?: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload?: boolean;
  /** Possible duplicates found before creating. The form turns its button into "Create anyway". */
  duplicates?: DuplicateMatch[];
  /** The name and PAN/VAT the duplicate search ran on, so a changed name is searched again. */
  checked?: { legalName: string; panVatNo: string };
}

/** What the add-contact action hands back. `savedCount` rises on each success and resets the form. */
export interface ContactFormState {
  key: string;
  errors: FieldErrors<ContactField>;
  error?: string;
  /** A short confirmation, such as "Sita Sharma was added." */
  saved?: string;
  savedCount: number;
}

export type { ContactValues, CustomerValues };
