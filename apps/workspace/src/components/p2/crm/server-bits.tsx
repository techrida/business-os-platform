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
import { isOverdue, LOG_ACTIVITY_KINDS } from './forms';
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
  collection_call: 'Collection call',
};

/** The four kinds a person logs (D39: `task` is gone; a follow-up is a planned call, meeting or email). */
export const LOGGABLE_KINDS = LOG_ACTIVITY_KINDS.map((k) => ({
  value: k,
  label: KIND_LABEL[k] ?? k,
}));

export const ALL_KINDS = ACTIVITY_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k }));

/** The kinds a list can be filtered by: every kind but `task`, which nothing creates any more. */
export const FILTER_KINDS = ALL_KINDS.filter((k) => k.value !== 'task');

/** History keeps logged and completed activities only: planned and cancelled ones never show. */
export function historyItems<A extends Pick<ActivityDto, 'planned' | 'cancelledAt'>>(
  items: readonly A[],
): A[] {
  return items.filter((a) => !a.planned && a.cancelledAt === null);
}

/** One word for where an activity stands: Planned, Overdue (planned and past due) or Done. */
export type ActivityState = 'Planned' | 'Overdue' | 'Done';
export function activityState(
  a: Pick<ActivityDto, 'planned' | 'dueAt' | 'completedAt'>,
  now: Date = new Date(),
): ActivityState | null {
  if (a.planned) return isOverdue(a, now) ? 'Overdue' : 'Planned';
  return a.completedAt ? 'Done' : null;
}

export const ACTIVITY_STATE_TONE = {
  Planned: 'info',
  Overdue: 'warning',
  Done: 'success',
} as const satisfies Record<ActivityState, 'info' | 'warning' | 'success'>;

/**
 * The time and the person on a History row. A completed follow-up shows when it was completed,
 * everything else when it happened. The actor is whoever logged it, or scheduled it when it was
 * planned first, by the display name the API joins onto the activity (D46); unknown only for older rows with no
 * author, and then left out.
 */
export function historyMeta(
  a: Pick<ActivityDto, 'occurredAt' | 'completedAt' | 'dueAt' | 'createdByName'>,
): { at: string; actor: string | null } {
  const name = a.createdByName;
  return {
    at: a.completedAt ?? a.occurredAt,
    actor: name ? `${a.dueAt ? 'Scheduled' : 'Logged'} by ${name}` : null,
  };
}

/** Where an activity's record lives, when this app has a page for it. */
function subjectLink(a: ActivityDto): { href: string; label: string } | null {
  if (a.leadId) return { href: `/leads/${a.leadId}`, label: 'Open lead' };
  if (a.opportunityId)
    return { href: `/opportunities/${a.opportunityId}`, label: 'Open opportunity' };
  return null;
}

/**
 * History: logged and completed activities, newest first as the API sends them (`status=logged`).
 * Planned and cancelled rows are dropped here too, so History never shows a follow-up before it is
 * done. Long text wraps; nothing is cut.
 */
export function ActivityList({
  items,
  record,
  showSubjectLink = false,
  empty,
}: {
  items: readonly ActivityDto[];
  /** The record this History belongs to; the empty state names it. */
  record: 'lead' | 'opportunity';
  showSubjectLink?: boolean;
  /** How to add one, or what will show here for a viewer who cannot. */
  empty: ReactNode;
}) {
  const rows = historyItems(items);
  if (rows.length === 0) {
    return (
      <EmptyState title={`No activities on this ${record} yet`} headingLevel={3} icon="inbox">
        {empty}
      </EmptyState>
    );
  }
  return (
    <ol className={styles.timeline}>
      {rows.map((a) => {
        const link = showSubjectLink ? subjectLink(a) : null;
        const { at, actor } = historyMeta(a);
        return (
          <li key={a.id} className={styles.entry}>
            <div className={styles.entryHead}>
              <Badge tone="neutral">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
              <span className={styles.entryTitle}>{a.subject}</span>
              {a.completedAt ? <Badge tone="success">Done</Badge> : null}
            </div>
            {a.body ? <p className={styles.entryBody}>{a.body}</p> : null}
            <p className={styles.entryWhen}>
              <time dateTime={at}>{when(at)}</time>
              {actor ? ` · ${actor}` : null}
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
