import type { FilterDescriptor, ListSpec } from '@/lib/list-params';

import { KIND_LABEL } from './invoice-status';

const KINDS = Object.keys(KIND_LABEL);

/** The list item carries no status (the server derives it on the invoice page), so the list filters by type. */
export const INVOICE_FILTER_SPEC = { multi: { kind: KINDS } } as const satisfies ListSpec;

export const KIND_OPTIONS = KINDS.map((value) => ({
  value,
  label: KIND_LABEL[value as keyof typeof KIND_LABEL],
}));

export const INVOICE_FILTER_LABELS: Record<string, FilterDescriptor> = {
  kind: {
    label: 'Type',
    format: (value) => KIND_LABEL[value as keyof typeof KIND_LABEL] ?? value,
  },
};
