'use client';

import type { ActivityDto, LeadOwnerOption } from '@bos/contracts';
import { useTransition } from 'react';

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

import { sentence } from './format';
import { ACTIVITY_KIND_LABELS, isOverdue } from './forms';
import styles from './follow-ups-card.module.css';
import { RescheduleFollowUpDialog, ScheduleFollowUpDialog } from './schedule-follow-up-dialog';

export interface FollowUpsCardProps {
  leadId: string;
  /** The lead's planned activities (`GET /v1/activities?leadId=&status=planned`). */
  items: readonly ActivityDto[];
  ownerUserId: string | null;
  /** People the caller may assign to (`GET /v1/leads/owners`); also resolves assignee names. */
  owners: readonly LeadOwnerOption[];
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

function changeForm(leadId: string, item: ActivityDto): FormData {
  const form = new FormData();
  form.set('leadId', leadId);
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

function FollowUpRow({
  leadId,
  item,
  owners,
  now,
}: {
  leadId: string;
  item: ActivityDto;
  owners: readonly LeadOwnerOption[];
  now: Date;
}) {
  const [pending, startTransition] = useTransition();
  const overdue = isOverdue(item, now);
  const owner = owners.find((o) => o.userId === item.assigneeUserId);
  const assignee = owner
    ? owner.displayName || owner.email
    : item.assigneeUserId
      ? 'Another teammate'
      : 'Unassigned';

  function complete() {
    startTransition(async () => {
      const result = await completeFollowUpAction({}, changeForm(leadId, item));
      report(result, 'Follow-up marked done.', 'The follow-up could not be completed.');
    });
  }

  async function cancel() {
    const result = await cancelFollowUpAction({}, changeForm(leadId, item));
    return report(result, 'Follow-up cancelled.', 'The follow-up could not be cancelled.');
  }

  return (
    <li className={styles.item} data-overdue={overdue} aria-busy={pending || undefined}>
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
            <Avatar name={assignee} size="small" shape="circle" />
            <span>{assignee}</span>
          </span>
        </p>
      </div>
      <div className={styles.actions}>
        <Button
          size="small"
          className={styles.action}
          disabled={pending}
          aria-label={`Complete ${item.subject}`}
          onClick={complete}
        >
          Complete
        </Button>
        <RescheduleFollowUpDialog
          leadId={leadId}
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
      </div>
    </li>
  );
}

/**
 * The lead's Follow-ups card (D39): planned calls, meetings and emails, earliest first, overdue
 * ones marked with the warning tone and the word "Overdue". Each can be completed (it moves to
 * History), rescheduled or cancelled; the header button schedules a new one.
 */
export function FollowUpsCard({
  leadId,
  items,
  ownerUserId,
  owners,
  now,
  className,
}: FollowUpsCardProps) {
  const planned = sortFollowUps(items);
  const at = now ?? new Date();
  return (
    <Panel
      title="Follow-ups"
      as="aside"
      className={className}
      actions={<ScheduleFollowUpDialog leadId={leadId} ownerUserId={ownerUserId} owners={owners} />}
    >
      {planned.length === 0 ? (
        <EmptyState title="No follow-ups planned" icon="calendar-days" headingLevel={3}>
          Schedule the next call, meeting or email so this lead does not go quiet.
        </EmptyState>
      ) : (
        <ol className={styles.list}>
          {planned.map((item) => (
            <FollowUpRow key={item.id} leadId={leadId} item={item} owners={owners} now={at} />
          ))}
        </ol>
      )}
    </Panel>
  );
}
