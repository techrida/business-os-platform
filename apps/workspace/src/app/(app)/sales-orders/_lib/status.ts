// How the sales-order words look in the workspace. Pure data and functions with no React import, so
// a list, a detail page and a test can all use them. Serves the NFR "the UI never shows data the
// contract does not promise": each table is a full record over the contract's values, so a status
// added to the contract is a compile error here until it has words.
import {
  SALES_ORDER_STATUSES,
  type SalesOrderDetail,
  type SalesOrderStatus,
  type ScheduleLineStatus,
  type ScheduleTrigger,
} from '@bos/contracts';

import type { StatusTone } from '@/components/p2/quotations/status';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

const ORDER: Record<SalesOrderStatus, StatusMeta> = {
  draft: { label: 'Draft', tone: 'neutral' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function salesOrderStatusMeta(status: SalesOrderStatus): StatusMeta {
  return ORDER[status];
}

/** The status filter's options, one per status in the contract's order. */
export const SALES_ORDER_FILTER_OPTIONS: readonly { value: SalesOrderStatus; label: string }[] =
  SALES_ORDER_STATUSES.map((value) => ({ value, label: ORDER[value].label }));

const LINE: Record<ScheduleLineStatus, StatusMeta> = {
  planned: { label: 'Planned', tone: 'neutral' },
  billable: { label: 'Ready to bill', tone: 'warning' },
  drafted: { label: 'Invoice drafted', tone: 'info' },
  invoiced: { label: 'Invoiced', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function scheduleLineStatusMeta(status: ScheduleLineStatus): StatusMeta {
  return LINE[status];
}

const TRIGGER: Record<ScheduleTrigger, string> = {
  advance: 'Advance, billable on confirmation',
  milestone: 'When a milestone is reached',
  uat: 'After user acceptance',
  delivery: 'On delivery',
  date: 'On a set date',
  manual: 'When Accounts decides',
};

export function triggerLabel(trigger: ScheduleTrigger): string {
  return TRIGGER[trigger];
}

const EVIDENCE: Record<SalesOrderDetail['evidence'][number]['kind'], string> = {
  contract: 'Contract',
  purchase_order: 'Customer purchase order',
  signed_quote: 'Signed quotation',
};

export function evidenceKindLabel(kind: SalesOrderDetail['evidence'][number]['kind']): string {
  return EVIDENCE[kind];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isGuid = (value: string): boolean => GUID.test(value);

/** Rows per page offered on the list; the first is the default. */
export const SALES_ORDER_ROW_OPTIONS = [10, 25, 50] as const;
export const SALES_ORDER_DEFAULT_ROWS = 25;

/**
 * What the sales-orders URL may carry, for `readList`: repeated `status` and `customerId` are kept
 * (each valid value once), anything else is dropped so a hand-edited URL never reaches the API
 * as a filter it would refuse.
 */
export const SALES_ORDER_LIST_SPEC = {
  multi: { status: SALES_ORDER_STATUSES, customerId: GUID },
  rows: { allowed: SALES_ORDER_ROW_OPTIONS, default: SALES_ORDER_DEFAULT_ROWS },
} as const;

export type LineAction = 'mark_billable' | 'draft_invoice' | 'open_invoice' | 'none';

/**
 * What one schedule line offers this person. A line that already has an invoice always links to it.
 * Otherwise only a confirmed order has actions: Mark billable on a planned line that is not the
 * advance (the advance starts billable), and Draft invoice on a billable one, each only with the
 * permission. The API still decides every call.
 */
export function lineAction(
  orderStatus: SalesOrderStatus,
  line: Pick<SalesOrderDetail['schedule'][number], 'status' | 'trigger' | 'invoiceId'>,
  can: { mark: boolean; draft: boolean },
): LineAction {
  if (line.invoiceId !== null) return 'open_invoice';
  if (orderStatus !== 'confirmed') return 'none';
  if (line.status === 'planned' && line.trigger !== 'advance') {
    return can.mark ? 'mark_billable' : 'none';
  }
  if (line.status === 'billable') return can.draft ? 'draft_invoice' : 'none';
  return 'none';
}
