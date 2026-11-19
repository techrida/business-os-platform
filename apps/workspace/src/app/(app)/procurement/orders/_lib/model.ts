import type { PoApprovedBand, PoStatus } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';

import type { Grants } from '@/lib/grants';
import { money } from '@/lib/kernel-format';

/**
 * What the purchase order screens show and offer, decided from the order's status and the person's
 * roles. Pure. The API still decides every call (deny by default); this only keeps buttons away
 * from people and statuses that would be refused.
 */

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export const PO_STATUS_LABEL: Record<PoStatus, { tone: BadgeTone; text: string }> = {
  draft: { tone: 'neutral', text: 'Draft' },
  issued: { tone: 'info', text: 'Issued' },
  partially_received: { tone: 'warning', text: 'Partly received' },
  fully_received: { tone: 'success', text: 'Fully received' },
  amendment_pending: { tone: 'warning', text: 'Amendment pending' },
  closed: { tone: 'neutral', text: 'Closed' },
  short_closed: { tone: 'neutral', text: 'Short-closed' },
  cancelled: { tone: 'error', text: 'Cancelled' },
};

export interface PoGrants {
  /** `procurement.po.issue`: every purchase order route needs it. */
  issue: boolean;
  /** `procurement.receipt.confirm`: the warehouse, who receives goods. */
  confirm: boolean;
}

/**
 * The two flags from the person's live grants (`getGrants`, GET /v1/me), not the role defaults, so a grant an admin
 * added or removed shows at once. Any scope counts: the API checks the order itself.
 */
export function poGrants(grants: Grants): PoGrants {
  return {
    issue: grants.has('procurement.po.issue'),
    confirm: grants.has('procurement.receipt.confirm'),
  };
}

export interface OrderActions {
  issue: boolean;
  amend: boolean;
  shortClose: boolean;
  cancel: boolean;
}

/**
 * The buttons for this status: issue a draft; amend while issued or partly received; short-close
 * once part has arrived; cancel only before anything arrived. An order waiting for an amendment
 * approval, and one that is over, take no action.
 */
export function orderActions(status: PoStatus, can: { issue: boolean }): OrderActions {
  const on = can.issue;
  return {
    issue: on && status === 'draft',
    amend: on && (status === 'issued' || status === 'partially_received'),
    shortClose: on && status === 'partially_received',
    cancel: on && status === 'issued',
  };
}

/**
 * The one header action shown as the primary button: the order's next step. Issue a draft, then
 * receive what arrives, then enter the vendor's bill. Amend, short-close and cancel change the
 * order rather than move it on, so they are never primary.
 */
export function primaryOrderAction(open: {
  issue: boolean;
  receive: boolean;
  enterBill: boolean;
}): 'issue' | 'receive' | 'enterBill' | null {
  if (open.issue) return 'issue';
  if (open.receive) return 'receive';
  if (open.enterBill) return 'enterBill';
  return null;
}

/** The approval tier of an amount (base < management < founder, AD7), as words. */
const BAND_LABEL: Record<PoApprovedBand, string> = {
  base: 'Base',
  management: 'Management',
  founder: 'Founder',
};

/** The approval band as words; a band this screen does not know yet is shown capitalised. */
export function bandText(band: string): string {
  const known = BAND_LABEL[band as PoApprovedBand] as string | undefined;
  if (known !== undefined) return known;
  const words = band.replaceAll('_', ' ').trim();
  return words === '' ? 'Not recorded' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** A PO takes new receipts only while issued or partly received. */
export function isReceivable(status: PoStatus): boolean {
  return status === 'issued' || status === 'partially_received';
}

/** `10.0000` shown as `10`, `2.5000` as `2.5`. Display only: the value is unchanged. */
export function qtyText(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

const CURRENCIES = ['NPR', 'INR', 'USD'] as const;

/**
 * Money from the server in the order's currency, grouped by the tenant's number system (left out:
 * lakh grouping for NPR and INR); an unknown currency keeps its code.
 */
export function poMoney(amount: string, currency: string, numberSystems?: NumberSystems): string {
  const known = CURRENCIES.find((c) => c === currency);
  return known !== undefined ? money(amount, known, numberSystems) : `${currency} ${amount}`;
}
