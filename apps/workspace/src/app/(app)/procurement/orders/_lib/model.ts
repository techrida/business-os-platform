import type { PoStatus } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';

import { hasPermission } from '@/components/p2/customers/permissions';
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

/** The permissions the session's roles hold by default. Server-side only. */
export function poGrants(roles: readonly string[]): PoGrants {
  return {
    issue: hasPermission(roles, 'procurement.po.issue'),
    confirm: hasPermission(roles, 'procurement.receipt.confirm'),
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
