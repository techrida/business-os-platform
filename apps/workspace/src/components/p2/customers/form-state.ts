import type { DuplicateMatch } from './duplicate-check';
import type { ContactErrors, ContactValues, CustomerErrors, CustomerValues } from './forms';

/** What the customer create and edit actions hand back to their form. */
export interface CustomerFormState {
  /** The idempotency key the next submit will use (create only). Rotated after a definite refusal. */
  key: string;
  errors: CustomerErrors;
  /** A refusal that is not about one field: 403, 409, 5xx or a lost connection. */
  error?: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload?: boolean;
  /** Possible duplicates found before creating. The form turns its button into "Create anyway". */
  duplicates?: DuplicateMatch[];
  /** The name and PAN/VAT the duplicate search ran on, so a changed name is searched again. */
  checked?: { legalName: string; panVatNo: string };
  /**
   * The API refused "Create anyway" without a reason (F1-Q55: 400 `duplicate_reason_required`), for
   * example a same-name organization added since the search. The form asks for the reason.
   */
  needsReason?: boolean;
}

/** What the add-contact action hands back. `savedCount` rises on each success and resets the form. */
export interface ContactFormState {
  key: string;
  errors: ContactErrors;
  error?: string;
  /** A short confirmation, such as "Sita Sharma was added." Shown as a toast. */
  saved?: string;
  savedCount: number;
  /**
   * Someone else made a main contact between this page loading and the save (409). Shown as a
   * toast; the page is revalidated, so the checkbox comes back disabled with its reason.
   */
  primaryTaken?: string;
}

export type { ContactValues, CustomerValues };

/** What the invite-portal-admin action hands back. `savedCount` rises on each success and closes the dialog. */
export interface PortalInviteState {
  key: string;
  errors: { contactId?: string };
  /** A refusal that blocks the invite, shown in the dialog. */
  error?: string;
  /** A short confirmation such as "An invitation was sent to ana@acme.test." Shown as a toast. */
  saved?: string;
  savedCount: number;
}
