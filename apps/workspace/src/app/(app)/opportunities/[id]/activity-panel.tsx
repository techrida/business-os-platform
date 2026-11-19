'use client';

import { useId, useState, type ReactNode } from 'react';

import { ActivityForm } from '@/components/p2/crm/activity-form';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';

import { logActivityAction } from '../../activities/actions';
import styles from './detail.module.css';

/** The opportunity's History with the shared Log activity form (type buttons, no follow-up). */
export function OpportunityActivities({
  opportunityId,
  children,
}: {
  opportunityId: string;
  children: ReactNode;
}) {
  const formId = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <Panel
      title="Activities"
      className={styles.records}
      actions={
        <Button
          variant="secondary"
          size="small"
          aria-controls={formId}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Hide form' : 'Add activity'}
        </Button>
      }
    >
      <div id={formId} className={styles.activityForm} hidden={!expanded}>
        <ActivityForm
          action={logActivityAction}
          subjectKind="opportunityId"
          subjectId={opportunityId}
        />
      </div>
      <div className={styles.activityList}>{children}</div>
    </Panel>
  );
}
