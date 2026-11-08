import type { ReactNode } from 'react';

import styles from './kit.module.css';

/**
 * Small presentational pieces shared by the inbox and memo screens. Markup only (no state, no
 * `use client`), so Server and Client Components can both import it.
 */

export type Tone = 'good' | 'wait' | 'bad' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  good: styles.good ?? '',
  wait: styles.wait ?? '',
  bad: styles.bad ?? '',
  neutral: '',
};

/** A status chip. The shape before the word (dot, diamond, square) backs up the colour. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`${styles.badge} ${TONE_CLASS[tone]}`}>{children}</span>;
}

const STATUS: Record<string, { tone: Tone; text: string }> = {
  // Approval requests and memos
  draft: { tone: 'neutral', text: 'Draft' },
  pending: { tone: 'wait', text: 'Waiting for approval' },
  submitted: { tone: 'wait', text: 'Submitted' },
  approved: { tone: 'good', text: 'Approved' },
  returned: { tone: 'wait', text: 'Returned for changes' },
  rejected: { tone: 'bad', text: 'Rejected' },
  blocked: { tone: 'bad', text: 'Blocked: no approver' },
  cancelled: { tone: 'neutral', text: 'Cancelled' },
  // Steps
  waiting: { tone: 'neutral', text: 'Not started' },
  active: { tone: 'wait', text: 'Waiting for a decision' },
  skipped: { tone: 'neutral', text: 'Skipped' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'neutral' as const, text: status };
  return <Badge tone={s.tone}>{s.text}</Badge>;
}

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
  const toneClass =
    tone === 'ok'
      ? styles.noticeOk
      : tone === 'bad'
        ? styles.noticeBad
        : tone === 'warn'
          ? styles.noticeWarn
          : '';
  return (
    <div className={`${styles.notice} ${toneClass}`} {...(role ? { role } : {})}>
      {children}
    </div>
  );
}
