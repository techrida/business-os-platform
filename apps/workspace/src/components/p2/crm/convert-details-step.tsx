'use client';
// Step 3 of the convert wizard: the deal. The opportunity's name, what it carries over from the lead, and, only when
// the server found a matching record, the reasoned "create anyway" override.
import styles from '@/app/(app)/leads/leads.module.css';
import { Alert } from '@/components/ui/alert';
import { Field, Input } from '@/components/ui/field';
import { FactList, Panel } from '@/components/ui/panel';
import { Checkbox } from '@/components/ui/checkbox';

import type { ConvertLead } from './convert-dialog';
import type { StepContext } from './convert-types';

export function DetailsStep({
  lead,
  ctx,
  hasDuplicates,
}: {
  lead: ConvertLead;
  ctx: StepContext;
  hasDuplicates: boolean;
}) {
  const { values, patch, set, err } = ctx;
  return (
    <>
      <Panel title="Opportunity details" headingLevel={3} className={styles.dialogPanel}>
        <Field label="Opportunity name" error={err['opportunityName']}>
          {(c) => (
            <Input
              name="opportunityName"
              value={values['opportunityName']}
              onChange={set('opportunityName')}
              maxLength={200}
              required
              {...c}
            />
          )}
        </Field>
        <FactList
          className={styles.conversionFacts ?? ''}
          facts={[
            { key: 'stage', label: 'Pipeline stage', value: 'Qualified' },
            { key: 'value', label: 'Estimated value', value: lead.value ?? 'Not set' },
            {
              key: 'probability',
              label: 'Probability',
              value: lead.probability == null ? 'Not set' : `${lead.probability}%`,
            },
            {
              key: 'close',
              label: 'Expected closing date',
              value: lead.expectedClose ?? 'Not set',
            },
          ]}
        />
        {lead.requirement ? (
          <Alert tone="info">
            <span className={styles.longText}>{lead.requirement}</span>
          </Alert>
        ) : null}
      </Panel>

      {hasDuplicates ? (
        <fieldset className={styles.conversionSection}>
          <legend className={styles.legend}>Or create anyway</legend>
          <label className={styles.choice}>
            <Checkbox
              name="createAnyway"
              checked={values['createAnyway'] !== ''}
              onCheckedChange={(checked) => patch({ createAnyway: checked ? 'on' : '' })}
            />
            Create new records even though a match exists
          </label>
          {values['createAnyway'] !== '' ? (
            <Field label="Reason" hint="Kept in the audit trail." error={err['overrideReason']}>
              {(c) => (
                <Input
                  name="overrideReason"
                  value={values['overrideReason']}
                  onChange={set('overrideReason')}
                  maxLength={500}
                  {...c}
                />
              )}
            </Field>
          ) : null}
        </fieldset>
      ) : null}
    </>
  );
}
