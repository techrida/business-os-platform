import type { CreditPositionView } from '@/components/p2/crm/credit-position';

import type { FieldErrors } from './forms';

/** What a sales-order action answers to its form. Types only, so the `'use server'` file stays pure. */
export interface ActionState {
  /** The key the next submit will use. Rotated after a final refusal, kept after an unknown outcome. */
  key: string;
  error?: string;
  /** Set when the page is out of date and the person should reload it. */
  reload?: boolean;
  /** One sentence per wrong field; the request never reached the API. */
  errors?: FieldErrors;
  /** The API accepted the request. */
  done?: boolean;
  /** Draft invoice answered SCHEDULE_LINE_TAKEN: the invoice already drafted for the line. */
  takenInvoiceId?: string;
  /**
   * Confirm answered `credit_hold` (F1-Q20): the deal whose credit hold stops the order, and what the
   * caller may do about it. `number` and `canOpen` come from reading the deal as the caller (a 404
   * leaves them null and false); `canOverride` is their live `credit.override` grant.
   * `quotationVersionId` is the version that was submitted: the refusal is about that quotation's
   * deal only, so a form that has since selected another quotation offers none of this.
   */
  creditHold?: {
    opportunityId: string;
    number: string | null;
    canOpen: boolean;
    canOverride: boolean;
    /** The position the hold is made of, for a `credit.override` holder (null when it could not be read). */
    position?: CreditPositionView;
    quotationVersionId: string;
  };
}
