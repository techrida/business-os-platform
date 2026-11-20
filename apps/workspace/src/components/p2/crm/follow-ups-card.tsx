'use client';

import type { ActivityDto, LeadOwnerOption } from '@bos/contracts';
import { useTransition, type ReactNode } from 'react';

import {
  cancelFollowUpAction,
  completeFollowUpAction,
  type FollowUpState,
} from '@/app/(app)/leads/actions';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';
import { when } from '@/lib/kernel-format';

import { subjectOf } from './follow-up-subject';
import { sentence } from './format';
import { ACTIVITY_KIND_LABELS, isOverdue } from './forms';
import styles from './follow-ups-card.module.css';
import { RescheduleFollowUpDialog, ScheduleFollowUpDialog } from './schedule-follow-up-dialog';

export interface FollowUpsCardProps {
  /** The lead the card belongs to. Without one (an opportunity's card) nothing can be scheduled. */
  leadId?: string | undefined;
  /** The record's planned activities (`GET /v1/activities?leadId=&status=planned`). */
  items: readonly ActivityDto[];
  ownerUserId?: string | null | undefined;
  /** People the caller may assign to (`GET /v1/leads/owners`): the Reschedule and Schedule choices. */
  owners: readonly LeadOwnerOption[];
  /** Offer Schedule follow-up in the header. Default: yes, when there is a lead. */
  schedule?: boolean | undefined;
  /** Whether the caller can complete, reschedule, cancel, or schedule follow-ups. Default: true. */
  canEdit?: boolean | undefined;
  /** The caller's `app.users.id`: without write access they can still complete follow-ups assigned to them. */
  currentUserId?: string | null | undefined;
  /** The time overdue is measured against. Default: now. */
  now?: Date | undefined;
  className?: string | undefined;
}

/** Planned only, earliest due first; a row without a due time (never expected) goes last. */
export function sortFollowUps(items: readonly ActivityDto[]): ActivityDto[] {
  const due = (a: ActivityDto) => {
    const at = a.dueAt ? Date.parse(a.dueAt) : Number.NaN;
    return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  };
  return items.filter((a) => a.planned).sort((a, b) => due(a) - due(b));
}

const kindLabel = (kind: string) =>
  kind in ACTIVITY_KIND_LABELS
    ? ACTIVITY_KIND_LABELS[kind as keyof typeof ACTIVITY_KIND_LABELS]
    : sentence(kind);

/** The change form names the follow-up's own subject, so the server knows which page to refresh. */
function changeForm(item: ActivityDto): FormData {
  const form = new FormData();
  const subject = subjectOf(item);
  if (subject) {
    form.set('subjectKind', subject.kind);
    form.set('subjectId', subject.id);
  }
  form.set('activityId', item.id);
  form.set('expectedVersion', String(item.version));
  return form;
}

/** Toast what happened; a refusal that a reload fixes offers the reload. */
function report(result: FollowUpState, success: string, failure: string): boolean {
  if (result.ok) {
    toast.success(success);
    return true;
  }
  toast.error(
    result.error ?? Object.values(result.fieldErrors ?? {})[0] ?? failure,
    result.reload
      ? { action: { label: 'Reload', onClick: () => window.location.reload() } }
      : undefined,
  );
  return false;
}

/**
 * The name shown for a follow-up's assignee: the display name the API joins onto the activity (D46), so it needs no
 * directory or owners list. Never an internal id.
 */
export function assigneeName(item: Pick<ActivityDto, 'assigneeUserId' | 'assigneeName'>): string {
  if (!item.assigneeUserId) return 'Unassigned';
  return item.assigneeName ?? 'Unnamed user';
}

/**
 * The assignee avatar's colour seed (their user id) and picture. Only the owners list carries a
 * picture; someone named only by the users directory, or unknown, shows seeded initials.
 */
export function assigneeAvatar(
  item: Pick<ActivityDto, 'assigneeUserId'>,
  owners: readonly LeadOwnerOption[],
): { seedId: string | null; imageDocumentId: string | null } {
  if (!item.assigneeUserId) return { seedId: null, imageDocumentId: null };
  const owner = owners.find((o) => o.userId === item.assigneeUserId);
  return { seedId: item.assigneeUserId, imageDocumentId: owner?.avatarDocumentId ?? null };
}

/**
 * Complete, Reschedule and Cancel for one planned follow-up, on any subject. Shared by the
 * Follow-ups card and the Planned table on /activities.
 */
export function FollowUpActions({
  item,
  owners,
  className,
  completeOnly = false,
}: {
  item: ActivityDto;
  owners: readonly LeadOwnerOption[];
  className?: string | undefined;
  /** Only Complete: an assignee with read access may finish their own follow-up but not move or cancel it. */
  completeOnly?: boolean | undefined;
}) {
  const [pending, startTransition] = useTransition();

  function complete() {
    startTransition(async () => {
      const result = await completeFollowUpAction({}, changeForm(item));
      report(result, 'Follow-up marked done.', 'The follow-up could not be completed.');
    });
  }

  async function cancel() {
    const result = await cancelFollowUpAction({}, changeForm(item));
    return report(result, 'Follow-up cancelled.', 'The follow-up could not be cancelled.');
  }

  return (
    <div className={className ?? styles.actions} aria-busy={pending || undefined}>
      <Button
        size="small"
        className={styles.action}
        disabled={pending}
        aria-label={`Complete ${item.subject}`}
        onClick={complete}
      >
        Complete
      </Button>
      {completeOnly ? null : (
        <>
          <RescheduleFollowUpDialog
            item={item}
            owners={owners}
            trigger={
              <Button
                variant="secondary"
                size="small"
                className={styles.action}
                disabled={pending}
                aria-label={`Reschedule ${item.subject}`}
              >
                Reschedule
              </Button>
            }
          />
          <ConfirmDialog
            trigger={
              <Button
                variant="ghost"
                size="small"
                className={styles.action}
                disabled={pending}
                aria-label={`Cancel ${item.subject}`}
              >
                Cancel
              </Button>
            }
            title="Cancel this follow-up?"
            description={`${item.subject} is removed from the plan. It does not appear in History.`}
            confirmLabel="Cancel follow-up"
            cancelLabel="Keep follow-up"
            destructive
            onConfirm={cancel}
          />
        </>
      )}
    </div>
  );
}

function FollowUpRow({
  item,
  owners,
  now,
  canEdit,
  currentUserId,
}: {
  item: ActivityDto;
  owners: readonly LeadOwnerOption[];
  now: Date;
  canEdit: boolean;
  currentUserId: string | null | undefined;
}) {
  const ownFollowUp = currentUserId != null && item.assigneeUserId === currentUserId;
  const overdue = isOverdue(item, now);
  const assignee = assigneeName(item);

  return (
    <li className={styles.item} data-overdue={overdue}>
      <div className={styles.main}>
        <p className={styles.subject}>
          <span className={styles.kind}>{kindLabel(item.kind)}: </span>
          {item.subject}
        </p>
        <p className={styles.meta}>
          {item.dueAt ? <time dateTime={item.dueAt}>{when(item.dueAt)}</time> : null}
          {overdue ? <Badge tone="warning">Overdue</Badge> : null}
        </p>
        <p className={styles.meta}>
          <span className={styles.assignee}>
            <Avatar name={assignee} {...assigneeAvatar(item, owners)} size="small" shape="circle" />
            <span>{assignee}</span>
          </span>
        </p>
      </div>
      {canEdit ? (
        <FollowUpActions item={item} owners={owners} />
      ) : ownFollowUp ? (
        <FollowUpActions item={item} owners={owners} completeOnly />
      ) : null}
    </li>
  );
}

/**
 * A record's planned follow-ups, earliest first, each with the actions the caller may take: all of
 * them with edit access, Complete alone on their own follow-up without it. `empty` shows when
 * nothing is planned. Used by the lead's Follow-ups card and the opportunity's Activities panel.
 */
export function FollowUpList({
  items,
  owners,
  canEdit = true,
  currentUserId,
  now,
  empty,
  label,
}: {
  items: readonly ActivityDto[];
  owners: readonly LeadOwnerOption[];
  canEdit?: boolean | undefined;
  currentUserId?: string | null | undefined;
  now?: Date | undefined;
  empty: ReactNode;
  /** An accessible name for the list, when no heading names it. */
  label?: string | undefined;
}) {
  const planned = sortFollowUps(items);
  if (planned.length === 0) return <>{empty}</>;
  const at = now ?? new Date();
  return (
    <ol className={styles.list} aria-label={label}>
      {planned.map((item) => (
        <FollowUpRow
          key={item.id}
          item={item}
          owners={owners}
          now={at}
          canEdit={canEdit}
          currentUserId={currentUserId}
        />
      ))}
    </ol>
  );
}

/**
 * A record's Follow-ups card (D39): planned calls, meetings and emails, earliest first, overdue
 * ones marked with the warning tone and the word "Overdue". Each can be completed (it moves to
 * History), rescheduled or cancelled; on a lead the header button schedules a new one.
 */
export function FollowUpsCard({
  leadId,
  items,
  ownerUserId,
  owners,
  schedule,
  canEdit = true,
  currentUserId,
  now,
  className,
}: FollowUpsCardProps) {
  const at = now ?? new Date();
  const scheduleFor = schedule === false || !canEdit ? undefined : leadId;
  return (
    <Panel
      title="Follow-ups"
      as="aside"
      className={className}
      actions={
        scheduleFor !== undefined ? (
          <ScheduleFollowUpDialog
            subjectId={scheduleFor}
            ownerUserId={ownerUserId ?? null}
            owners={owners}
          />
        ) : undefined
      }
    >
      <FollowUpList
        items={items}
        owners={owners}
        canEdit={canEdit}
        currentUserId={currentUserId}
        now={at}
        empty={
          <EmptyState title="No follow-ups planned" icon="calendar-days" headingLevel={3}>
            {scheduleFor !== undefined
              ? 'Schedule the next call, meeting or email so this lead does not go quiet.'
              : null}
          </EmptyState>
        }
      />
    </Panel>
  );
}
