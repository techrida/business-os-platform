import type { ReactNode } from 'react';

import { Alert, type AlertTone } from '@/components/ui/alert';
import { Badge as UiBadge } from '@/components/ui/badge';

/**
 * What the memo screens still import from here. Each piece is a thin wrapper over a shared
 * component in components/ui, kept so the call sites do not change; new code should use the
 * shared components directly (Badge, Alert, Table, Panel, ...). Markup only (no state, no
 * `use client`), so Server and Client Components can both import it.
 */

export type Tone = 'good' | 'wait' | 'bad' | 'neutral';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const BADGE_TONE: Record<Tone, BadgeTone> = {
  good: 'success',
  wait: 'warning',
  bad: 'error',
  neutral: 'neutral',
};

/** A status pill. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <UiBadge tone={BADGE_TONE[tone]}>{children}</UiBadge>;
}

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
  return <UiBadge tone={s.tone}>{s.text}</UiBadge>;
}

/** The words for a status, for places that are not a badge (a timeline segment). */
export function statusText(status: string): string {
  return STATUS[status]?.text ?? status;
}

const NOTICE_TONE: Record<'ok' | 'bad' | 'warn' | 'info', AlertTone> = {
  ok: 'success',
  bad: 'error',
  warn: 'warning',
  info: 'info',
};

/** An inline message. Wraps the shared Alert; see it for how `role` is used. */
export function Notice({
  tone,
  role,
  children,
}: {
  tone: 'ok' | 'bad' | 'warn' | 'info';
  /** `alert` interrupts, `status` waits for a pause; omit for static text. */
  role?: 'alert' | 'status';
  children: ReactNode;
}) {
  return (
    <Alert tone={NOTICE_TONE[tone]} {...(role ? { role } : {})}>
      {children}
    </Alert>
  );
}
