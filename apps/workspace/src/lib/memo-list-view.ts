// Pure helpers for the Memos list screen. No server-only imports, so they are unit-testable.
import type { MemoListItem } from '@bos/contracts';

/** Rows per page the screen asks for (the API allows more; this keeps a page quick to scan). */
export const MEMO_PAGE_SIZE = 20;

/** The status filter offered above the list; "All" is the absence of a filter. */
export const MEMO_STATUS_FILTERS = [
  { value: 'draft', label: 'Drafts' },
  { value: 'submitted', label: 'Waiting for approval' },
  { value: 'returned', label: 'Returned' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
] as const;

/** A cursor from the URL, if it looks like one the API issued. The API re-checks; this only drops array and junk values. */
export function safeCursor(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,300}$/.test(value) ? value : undefined;
}

/** The small line under a memo's title: where it belongs and who started it. Empty parts are left out. */
export function memoRowNote(memo: Pick<MemoListItem, 'departmentName' | 'ownerName'>): string {
  return [memo.departmentName, memo.ownerName?.trim() ? `by ${memo.ownerName.trim()}` : null]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' · ');
}
