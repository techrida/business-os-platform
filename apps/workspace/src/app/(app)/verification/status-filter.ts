// Server-safe: the queue page reads the status filter here and the client filter writes the same values.
import type { VerificationStatus } from '@bos/contracts';

import { parseStatusFilters } from '@/components/p2/customers/format';
import { hrefWith, type RawParams } from '@/lib/list-params';

/** `?status=all` lists every case; with no `status` param the queue shows the cases awaiting review. */
export const ALL_STATUSES = 'all';
export const DEFAULT_STATUSES: readonly VerificationStatus[] = ['submitted'];

export interface StatusFilter {
  /** Statuses to ask the API for; empty means every status. */
  status: VerificationStatus[];
  /** The URL asked for every status. */
  all: boolean;
  /** No usable status in the URL, so the default applies. */
  isDefault: boolean;
}

export function readStatusFilter(raw: string | string[] | undefined): StatusFilter {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (values.includes(ALL_STATUSES)) return { status: [], all: true, isDefault: false };
  const status = parseStatusFilters(raw);
  return status.length > 0
    ? { status, all: false, isDefault: false }
    : { status: [...DEFAULT_STATUSES], all: false, isDefault: true };
}

/** The status param for a selection: none chosen means every status, never the default again. */
export const statusParam = (values: readonly string[]): string | readonly string[] =>
  values.length === 0 ? ALL_STATUSES : values;

/** Clearing the filters shows every case; dropping `status` alone would bring the default back. */
export const clearVerificationFiltersHref = (params: RawParams): string =>
  hrefWith('/verification', params, { q: undefined, status: ALL_STATUSES });
