'use client';

import type { NumberSystemSetting } from '@bos/contracts';
import { useActionState, useState } from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import { IDLE, type ActionState } from '@/app/(app)/settings/action-state';
import { FormStatus } from '@/app/(app)/settings/form-status';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';

import { numberSystemOptions } from './number-format';
import styles from './number-system-card.module.css';

/**
 * Number grouping and amount in words: two radio cards, each with its worked example drawn by the
 * same formatters the documents use. One card, one decision, one Save (enabled only when the choice
 * differs from what is saved). The server action is passed in so this component owns no route.
 */
export function NumberSystemCard({
  current,
  action,
}: {
  current: NumberSystemSetting;
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [value, setValue] = useState<NumberSystemSetting>(current);
  const [state, formAction, pending] = useActionState(action, IDLE);
  const options = numberSystemOptions();
  const error = state.status === 'error' ? state.fieldErrors?.['numberSystem'] : undefined;

  return (
    <Panel
      title="Number grouping"
      description="Used for every amount on screen and on documents, and for the amount in words under the totals."
    >
      <form action={formAction} className={shell.form} noValidate>
        <fieldset className={styles.group}>
          <legend className="sr-only">Number grouping</legend>
          <div className={styles.options}>
            {options.map((option) => (
              <label key={option.value} className={styles.option}>
                <input
                  type="radio"
                  name="numberSystem"
                  value={option.value}
                  checked={value === option.value}
                  onChange={() => setValue(option.value)}
                  className={styles.radio}
                />
                <span className={styles.body}>
                  <span className={styles.name}>{option.name}</span>
                  <span className={styles.amount}>{option.amount}</span>
                  <span className={styles.words}>{option.words}</span>
                </span>
              </label>
            ))}
          </div>
          {error ? (
            <span className={styles.error} role="alert">
              {error}
            </span>
          ) : null}
        </fieldset>
        <div className={shell.foot}>
          <div className={shell.status}>
            <FormStatus state={state} pending={pending} />
          </div>
          <Button type="submit" disabled={value === current || pending}>
            Save
          </Button>
        </div>
      </form>
    </Panel>
  );
}
