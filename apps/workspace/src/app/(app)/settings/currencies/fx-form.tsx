'use client';

import { RATE_LIMITS } from '@bos/contracts';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Input, Select } from '@/components/ui/field';
import { DecimalInput } from '@/components/ui/number-input';

import { IDLE } from '../action-state';
import { FormStatus } from '../ui';
import { addFxRateAction } from './actions';
import styles from '../_components/settings.module.css';

export function FxForm({ today }: { today: string }) {
  const [state, formAction, pending] = useActionState(addFxRateAction, IDLE);
  const kept = state.status === 'error' ? (state.fields ?? {}) : {};

  return (
    <form action={formAction} className={styles.form}>
      <div className={styles.formRow}>
        <Field label="Currency" error={state.fieldErrors?.currency}>
          {(control) => (
            <Select name="currency" defaultValue={kept.currency ?? 'USD'} {...control}>
              <option value="USD">USD</option>
              <option value="INR">INR</option>
            </Select>
          )}
        </Field>
        <Field
          error={state.fieldErrors?.rateNpr}
          label="Rate (NPR for 1 unit)"
          hint="Up to 6 decimals."
        >
          {(control) => (
            <DecimalInput
              {...control}
              name="rateNpr"
              intDigits={RATE_LIMITS.intDigits}
              scale={RATE_LIMITS.scale}
              required
              defaultValue={kept.rateNpr ?? ''}
            />
          )}
        </Field>
        <Field label="Applies from" error={state.fieldErrors?.rateDate}>
          {(control) => (
            <DatePicker
              name="rateDate"
              required
              defaultValue={kept.rateDate ?? today}
              {...control}
            />
          )}
        </Field>
        <Field label="Source" error={state.fieldErrors?.source}>
          {(control) => (
            <Input
              name="source"
              autoComplete="off"
              placeholder="manual"
              defaultValue={kept.source ?? ''}
              {...control}
            />
          )}
        </Field>
      </div>
      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          Add rate
        </Button>
        <div className={styles.status}>
          <FormStatus state={state} pending={pending} />
        </div>
      </div>
    </form>
  );
}
