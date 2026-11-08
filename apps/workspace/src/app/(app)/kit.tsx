import { Badge } from '@/components/ui/badge';

/**
 * What the inbox detail page still imports from here: the words and badge for a status. Markup
 * only (no state, no `use client`), so Server and Client Components can both import it. New code
 * should use the shared components directly (Badge, Alert, Table, Panel, ...).
 */

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const STATUS: Record<string, { tone: BadgeTone; text: string }> = {
  // Approval requests and memos
  draft: { tone: 'neutral', text: 'Draft' },
  pending: { tone: 'warning', text: 'Waiting for approval' },
  submitted: { tone: 'warning', text: 'Submitted' },
  approved: { tone: 'success', text: 'Approved' },
  returned: { tone: 'warning', text: 'Returned for changes' },
  rejected: { tone: 'error', text: 'Rejected' },
  blocked: { tone: 'error', text: 'Blocked: no approver' },
  cancelled: { tone: 'neutral', text: 'Cancelled' },
  // Steps
  waiting: { tone: 'neutral', text: 'Not started' },
  active: { tone: 'info', text: 'Waiting for a decision' },
  skipped: { tone: 'neutral', text: 'Skipped' },
};

/** The state of an approval request, a memo or an approval step, in words. */
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'neutral' as const, text: status };
  return <Badge tone={s.tone}>{s.text}</Badge>;
}

/** The words for a status, for places that are not a badge (a timeline segment). */
export function statusText(status: string): string {
  return STATUS[status]?.text ?? status;
}
