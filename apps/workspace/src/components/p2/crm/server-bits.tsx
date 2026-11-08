import type { ActivityDto, RecordKind } from '@bos/contracts';
import { ACTIVITY_KINDS } from '@bos/contracts';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';
import { when } from '@/lib/kernel-format';

import styles from './crm.module.css';
import { stageLabel, stageTone } from './stages';

/** The stage as a badge: colour only where it means done, lost or held. */
export function StageBadge({ kind, stage }: { kind: RecordKind; stage: string }) {
  return <Badge tone={stageTone(kind, stage)}>{stageLabel(kind, stage)}</Badge>;
}

/**
 * A failed load, in words. A 403 is "your roles do not include this", not an error: it uses the
 * same pattern as the inbox. Everything else offers a reload.
 */
export function LoadProblem({
  status,
  message,
  what,
  reloadHref,
}: {
  status: number;
  message: string;
  /** "leads", "the opportunity", for the title. */
  what: string;
  reloadHref: string;
}) {
  const forbidden = status === 403;
  return (
    <Alert
      tone={forbidden ? 'info' : 'error'}
      role="alert"
      title={forbidden ? `Your roles do not include ${what}` : `${capitalise(what)} did not load`}
      actions={forbidden ? null : <Link href={reloadHref}>Reload</Link>}
    >
      {forbidden ? 'Ask an administrator if you need access to this part of the CRM.' : message}
    </Alert>
  );
}

function capitalise(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

const KIND_LABEL: Record<string, string> = {
  call: 'Call',
  meeting: 'Meeting',
  email: 'Email',
  note: 'Note',
  task: 'Task',
  stage_change: 'Stage change',
  system: 'System',
};

/** Only the five kinds a person logs; the server writes the other two. */
export const LOGGABLE_KINDS = ACTIVITY_KINDS.filter(
  (k) => k !== 'stage_change' && k !== 'system',
).map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }));

export const ALL_KINDS = ACTIVITY_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }));

/** Where an activity's record lives, when this app has a page for it. */
function subjectLink(a: ActivityDto): { href: string; label: string } | null {
  if (a.leadId) return { href: `/leads/${a.leadId}`, label: 'Open lead' };
  if (a.opportunityId)
    return { href: `/opportunities/${a.opportunityId}`, label: 'Open opportunity' };
  return null;
}

/** A list of activities, newest first as the API sends them. Long text wraps; nothing is cut. */
export function ActivityList({
  items,
  showSubjectLink = false,
  empty,
}: {
  items: readonly ActivityDto[];
  showSubjectLink?: boolean;
  empty: ReactNode;
}) {
  if (items.length === 0) {
    return (
      <EmptyState title="No activity yet" headingLevel={3} icon="inbox">
        {empty}
      </EmptyState>
    );
  }
  return (
    <ol className={styles.timeline}>
      {items.map((a) => {
        const link = showSubjectLink ? subjectLink(a) : null;
        return (
          <li key={a.id} className={styles.entry}>
            <div className={styles.entryHead}>
              <Badge tone="neutral">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
              <span className={styles.entryTitle}>{a.subject}</span>
              {a.completedAt ? <Badge tone="success">Done</Badge> : null}
            </div>
            {a.body ? <p className={styles.entryBody}>{a.body}</p> : null}
            <p className={styles.entryWhen}>
              <time dateTime={a.occurredAt}>{when(a.occurredAt)}</time>
              {a.dueAt && !a.completedAt ? (
                <>
                  {' · Due '}
                  <time dateTime={a.dueAt}>{when(a.dueAt)}</time>
                </>
              ) : null}
              {link ? (
                <>
                  {' · '}
                  <Link href={link.href}>{link.label}</Link>
                </>
              ) : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/** Two links that switch a list between its table and its board. A nav, so it is keyboard native. */
export function ViewSwitch({
  current,
  hrefs,
}: {
  current: 'table' | 'board';
  hrefs: { table: string; board: string };
}) {
  return (
    <nav aria-label="View" className={styles.views}>
      <Link
        href={hrefs.table}
        className={styles.view}
        aria-current={current === 'table' ? 'page' : undefined}
      >
        Table
      </Link>
      <Link
        href={hrefs.board}
        className={styles.view}
        aria-current={current === 'board' ? 'page' : undefined}
      >
        Board
      </Link>
    </nav>
  );
}

/** Shown while a CRM page loads: row-shaped placeholders so the page does not jump. */
export function PageSkeleton({ title, what }: { title: string; what: string }) {
  return (
    <Page aria-busy="true">
      <PageHeader title={title} />
      <p className="sr-only" role="status">
        Loading {what}
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="40%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
