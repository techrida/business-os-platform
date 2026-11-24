/**
 * The Commercial terms card's edits: what each one hands back, and the checks made before anything is sent. Pure,
 * so the card's client forms and the server actions share one rule. Amounts stay strings: nothing here does
 * arithmetic on money (D22).
 */

import { CreditLimitSchema } from '@bos/contracts';
import { NO_SPACES, USE_A_POINT, hasInnerSpace, hasStrayComma, plainAmount } from '@bos/locale';

/** The three fields the card edits, one save each. Portal access is the existing invite, not an edit here. */
export type TermsField = 'owner' | 'paymentTerms' | 'creditLimit';

/** What a card edit hands back. `savedCount` rises on each success and closes the dialog. */
export interface TermsEditState {
  /** A refusal about the value itself, shown under the field. */
  errors: { value?: string };
  /** A refusal that is not about the value (403, 404, 5xx, lost connection), shown at the top of the dialog. */
  error?: string;
  /**
   * Someone else saved first (409). The page data was reloaded, so the card and the dialog now show the latest
   * value and version; saving again is a fresh, informed decision.
   */
  stale?: boolean;
  /**
   * The person switched legal entity (in another tab) after this page loaded (409 `entity_changed`). Nothing was
   * saved and the page data is NOT reloaded: a reload would point the open dialog at the other entity's terms, so
   * the next Save would land there. The dialog stays open to read the message, cancel and reload.
   */
  entityChanged?: boolean;
  /** Not a failure: a save with nothing changed. Shown as a neutral notice in the dialog. */
  notice?: string;
  /** A short confirmation, shown as a toast. */
  saved?: string;
  savedCount: number;
}

export const TERMS_START: TermsEditState = { errors: {}, savedCount: 0 };

export const NO_PERMISSION: Record<TermsField, string> = {
  owner:
    "Your roles do not include changing a customer's account owner. Ask an administrator if you need to.",
  paymentTerms:
    'Your roles do not include changing payment terms. Ask an administrator if you need to.',
  creditLimit:
    'Your roles do not include setting credit limits. Ask an administrator if you need to.',
};

/**
 * A 409. Payment terms and the credit limit share one version (the terms row), so a limit saved by someone else
 * makes a payment-term save stale too: the sentence names the terms, not the one field.
 */
export function staleMessage(field: TermsField): string {
  const what = field === 'owner' ? 'this customer' : "this customer's terms";
  return `Someone else changed ${what} while you were editing. The page now shows what they saved; check it, then save again if you still want your change.`;
}

/** A 409 `entity_changed`: the form was rendered for another legal entity than the one the person acts for now. */
export const ENTITY_CHANGED =
  'You switched to another legal entity since this page loaded, so nothing was saved. Reload the page to see the terms of the entity you act for now, then save again.';

export const NOTHING_CHANGED = 'Nothing changed, so there is nothing to save.';
export const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';
export const CUSTOMER_GONE =
  'This customer is no longer available. Reload the page to see where it went.';
export const OWNER_REFUSED =
  'This person cannot own customers: they are disabled or no longer on the staff. Choose someone else.';
export const OWNER_REQUIRED = 'Choose who owns this customer.';

/** What the credit limit does, in the words the card and the dialog both use (R4a Q1b, F1-Q20). */
export const CREDIT_LIMIT_NOTE =
  'When a sales order is confirmed, the open receivables plus that order are compared with this limit. An order that goes over it needs a credit override first.';

export const LIMIT_REQUIRED = 'Enter the credit limit in NPR, or choose No limit.';
export const LIMIT_INVALID =
  'Enter an amount in NPR with up to two decimals, for example 1,00,000.00. It cannot be negative.';

export type CreditLimitMode = 'limit' | 'none';

/**
 * The credit limit to send, from the dialog's choice and the typed amount. "No limit" is null; a typed amount is
 * NPR with up to two decimals, never negative, and lakh grouping ("1,00,000.00") is accepted. An empty amount with
 * "Set a limit" chosen is an error, never null and never 0.00: zero is a real limit (it holds any order that credit
 * on account does not cover).
 */
export function parseCreditLimit(
  mode: string,
  raw: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (mode === 'none') return { ok: true, value: null };
  if (mode !== 'limit') return { ok: false, error: INCOMPLETE };
  const typed = plainAmount(raw);
  if (typed === '') return { ok: false, error: LIMIT_REQUIRED };
  // "10 50" is not 1050: say what to fix rather than the generic sentence.
  if (hasInnerSpace(raw)) return { ok: false, error: NO_SPACES };
  if (!CreditLimitSchema.safeParse(typed).success) {
    return {
      ok: false,
      error: hasStrayComma(raw) ? `${USE_A_POINT} ${LIMIT_INVALID}` : LIMIT_INVALID,
    };
  }
  return { ok: true, value: typed };
}

/**
 * The same amount written two ways ("100000" and "100000.00", "0" and "0.00") compares equal; null (no limit) equals
 * only null. A string comparison, not arithmetic.
 */
export function sameLimit(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const canonical = (s: string) => {
    const [whole = '', fraction = ''] = s.split('.');
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
  };
  return canonical(a) === canonical(b);
}
