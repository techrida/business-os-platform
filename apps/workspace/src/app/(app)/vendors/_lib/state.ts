import type { VendorStatus } from '@bos/contracts';

import type { FieldErrors, VendorField } from './forms';

/** What the vendor create and edit actions hand back to their form. */
export interface VendorFormState {
  /** The idempotency key the next submit will use (create). Rotated after a definite refusal. */
  key: string;
  errors: FieldErrors<VendorField>;
  /** A refusal that is not about one field: 403, 409, 5xx or a lost connection. */
  error?: string;
  /** Not a failure: a save with nothing changed. Shown as a neutral notice, not the red "Nothing was saved". */
  notice?: string;
  /** The page is out of date: offer a reload instead of a retry. */
  reload?: boolean;
  /**
   * TR-Q12d: vendors whose legal name matches the one being added. Nothing was created; the form
   * shows them and asks the person to confirm it is a different vendor before adding it.
   */
  sameName?: { id: string; legalName: string; status: VendorStatus }[];
}

/**
 * What the panel actions (contact, lifecycle, bank account, portal grant) hand back. `savedCount`
 * rises on each success, so the form keyed on it clears itself while a refusal keeps what was typed.
 */
export interface PanelState<K extends string = string> {
  key: string;
  errors: FieldErrors<K>;
  error?: string;
  reload?: boolean;
  /** A short confirmation, such as "Sita Sharma was added." */
  saved?: string;
  /**
   * The vendor had moved on since the page was drawn (a stale button), and the action has refreshed the page.
   * The form that sent it may be gone from the new page, so the refusal is raised as a toast.
   */
  refreshed?: boolean;
  savedCount: number;
}

export function panelStart<K extends string = string>(key: string): PanelState<K> {
  return { key, errors: {}, savedCount: 0 };
}
