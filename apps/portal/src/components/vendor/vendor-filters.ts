import {
  VENDOR_PORTAL_BILL_STATUSES,
  VENDOR_VISIBLE_PO_STATUSES,
  type VendorPortalBillStatus,
  type VendorVisiblePoStatus,
} from '@bos/contracts';

import type { FilterDescriptor, ListSpec } from '@/lib/list-params';

import { BILL_STATUS_LOOK, PO_STATUS_LOOK } from './vendor-status';

export const PO_FILTER_SPEC = {
  multi: { status: VENDOR_VISIBLE_PO_STATUSES },
} as const satisfies ListSpec;

export const PO_STATUS_OPTIONS = VENDOR_VISIBLE_PO_STATUSES.map((value) => ({
  value,
  label: PO_STATUS_LOOK[value].label,
}));

export const PO_FILTER_LABELS: Record<string, FilterDescriptor> = {
  status: {
    label: 'Status',
    format: (value) => PO_STATUS_LOOK[value as VendorVisiblePoStatus]?.label ?? value,
  },
};

export const BILL_FILTER_SPEC = {
  multi: { status: VENDOR_PORTAL_BILL_STATUSES },
} as const satisfies ListSpec;

export const BILL_STATUS_OPTIONS = VENDOR_PORTAL_BILL_STATUSES.map((value) => ({
  value,
  label: BILL_STATUS_LOOK[value].label,
}));

export const BILL_FILTER_LABELS: Record<string, FilterDescriptor> = {
  status: {
    label: 'Status',
    format: (value) => BILL_STATUS_LOOK[value as VendorPortalBillStatus]?.label ?? value,
  },
};

/** An RFQ has no status field: it is open until its deadline passes, the same split the list badges show. */
export const RFQ_STATES = ['open', 'closed'] as const;
export type RfqState = (typeof RFQ_STATES)[number];

const RFQ_STATE_LABEL: Record<RfqState, string> = {
  open: 'Open for quotations',
  closed: 'Deadline passed',
};

export const RFQ_FILTER_SPEC = { multi: { status: RFQ_STATES } } as const satisfies ListSpec;

export const RFQ_STATUS_OPTIONS = RFQ_STATES.map((value) => ({
  value,
  label: RFQ_STATE_LABEL[value],
}));

export const RFQ_FILTER_LABELS: Record<string, FilterDescriptor> = {
  status: {
    label: 'Status',
    format: (value) => RFQ_STATE_LABEL[value as RfqState] ?? value,
  },
};
