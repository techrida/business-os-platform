import { PAYMENT_STATUSES } from '@bos/contracts';

import type { FilterDescriptor, ListSpec } from '@/lib/list-params';

import { PAYMENT_STATUS_LOOK } from './payment-status';

export const PAYMENT_FILTER_SPEC = {
  multi: { status: PAYMENT_STATUSES },
} as const satisfies ListSpec;

export const PAYMENT_STATUS_OPTIONS = PAYMENT_STATUSES.map((value) => ({
  value,
  label: PAYMENT_STATUS_LOOK[value].label,
}));

export const PAYMENT_FILTER_LABELS: Record<string, FilterDescriptor> = {
  status: {
    label: 'Status',
    format: (value) =>
      PAYMENT_STATUS_LOOK[value as keyof typeof PAYMENT_STATUS_LOOK]?.label ?? value,
  },
};
