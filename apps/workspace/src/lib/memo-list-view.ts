// Pure helpers for the Memos list screen. No server-only imports, so they are unit-testable.
import type { MemoListItem } from '@bos/contracts';

/** Rows per page the screen asks for (the API allows more; this keeps a page quick to scan). */
export const MEMO_PAGE_SIZE = 20;

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

export interface MemoSummaryCard {
  key: 'all' | 'draft' | 'submitted' | 'returned' | 'approved';
  label: string;
  value: number;
  icon: 'file-text' | 'list' | 'inbox' | 'alert-triangle' | 'check-circle';
  tone: 'info' | 'success' | 'warning' | 'error' | 'neutral';
}

/**
 * The KPI cards over the memos the caller may open, from one count per status (each the `total` of a list read
 * filtered to that status). "All memos" is their sum, so it can never disagree with the cards beside it.
 * Rejected memos count toward the total but get no card of their own.
 */
export function memoSummaryCards(counts: Readonly<Record<string, number>>): MemoSummaryCard[] {
  const at = (status: string) => counts[status] ?? 0;
  const all = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return [
    { key: 'all', label: 'All memos', value: all, icon: 'file-text', tone: 'info' },
    { key: 'draft', label: 'Drafts', value: at('draft'), icon: 'list', tone: 'neutral' },
    {
      key: 'submitted',
      label: 'Waiting for approval',
      value: at('submitted'),
      icon: 'inbox',
      tone: 'warning',
    },
    {
      key: 'returned',
      label: 'Returned',
      value: at('returned'),
      icon: 'alert-triangle',
      tone: 'error',
    },
    {
      key: 'approved',
      label: 'Approved',
      value: at('approved'),
      icon: 'check-circle',
      tone: 'success',
    },
  ];
}
