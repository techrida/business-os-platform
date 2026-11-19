// What the Memos list reads from its URL. No client code here, so the page and the toolbar share one definition.
import { MEMO_STATUSES } from '@bos/contracts';

import { safeCursor } from '@/lib/memo-list-view';
import { type ListSpec, type RawParams } from '@/lib/list-params';

export const MEMO_LIST_SPEC = { multi: { status: MEMO_STATUSES } } as const satisfies ListSpec;

const STATUS_LABELS: Record<(typeof MEMO_STATUSES)[number], string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  returned: 'Returned',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const statusLabel = (value: string): string =>
  STATUS_LABELS[value as keyof typeof STATUS_LABELS] ?? value;

export const MEMO_STATUS_OPTIONS = MEMO_STATUSES.map((value) => ({
  value,
  label: statusLabel(value),
}));

/**
 * The keyset cursor of the page being shown. It travels in the `page` param because every filter change drops
 * `page` (and nothing else), so a new filter starts again from the newest memo instead of from a stale position.
 */
export const cursorOf = (params: RawParams): string | undefined => safeCursor(params.page);
