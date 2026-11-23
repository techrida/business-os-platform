'use client';

import type { LeadOwnerOption } from '@bos/contracts';
import { useId, useState, type ReactNode } from 'react';

import { ActivityForm } from '@/components/p2/crm/activity-form';
import {
  ScheduleFollowUpDialog,
  type NamedPerson,
} from '@/components/p2/crm/schedule-follow-up-dialog';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';

import { logActivityAction } from '../../activities/actions';
import styles from './detail.module.css';

/**
 * The opportunity's Activities (U16-Q6): what is planned next, then what happened. Planned
 * follow-ups (a lead's open ones carry here at convert) sit under "Planned" with their due time and
 * actions; logged calls, meetings, emails and notes sit under "History". Editors schedule a
 * follow-up or log an activity from the header.
 */
export function OpportunityActivities({
  opportunityId,
  canEdit = true,
  ownerUserId,
  ownerName,
  me,
  owners,
  planned,
  children,
}: {
  opportunityId: string;
  canEdit?: boolean;
  /** The deal's owner, the default assignee of a new follow-up. */
  ownerUserId: string | null;
  /** The owner's name from the record, shown when they are not in `owners`. */
  ownerName?: string | null;
  /** The signed-in user, named when the deal has no owner. */
  me?: NamedPerson | null;
  /** People a follow-up may go to (`GET /v1/opportunities/follow-up-assignees`); empty leaves it to the API. */
  owners: readonly LeadOwnerOption[];
  /** The planned follow-ups, or why they did not load. */
  planned: ReactNode;
  /** The logged history. */
  children: ReactNode;
}) {
  const formId = useId();
  const plannedId = useId();
  const historyId = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <Panel
      title="Activities"
      className={styles.records}
      actions={
        canEdit ? (
          <div className={styles.activityActions}>
            <ScheduleFollowUpDialog
              subjectKind="opportunityId"
              subjectId={opportunityId}
              ownerUserId={ownerUserId}
              ownerName={ownerName}
              me={me}
              owners={owners}
              trigger={
                <Button variant="secondary" size="small">
                  Schedule follow-up
                </Button>
              }
            />
            <Button
              variant="secondary"
              size="small"
              aria-controls={formId}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Hide form' : 'Log activity'}
            </Button>
          </div>
        ) : undefined
      }
    >
      {canEdit ? (
        <div id={formId} className={styles.activityForm} hidden={!expanded}>
          <ActivityForm
            action={logActivityAction}
            subjectKind="opportunityId"
            subjectId={opportunityId}
          />
        </div>
      ) : null}
      <section aria-labelledby={plannedId} className={styles.activitySection}>
        <h3 id={plannedId} className={styles.sectionTitle}>
          Planned
        </h3>
        <div className={styles.plannedList}>{planned}</div>
      </section>
      <section aria-labelledby={historyId} className={styles.activitySection}>
        <h3 id={historyId} className={styles.sectionTitle}>
          History
        </h3>
        <div className={styles.activityList}>{children}</div>
      </section>
    </Panel>
  );
}
