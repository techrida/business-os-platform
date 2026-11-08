'use client';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

import { scheduleMessage, scheduleState, type MilestoneValues } from './model';
import type { PaymentTerm } from './schemas';
import styles from './quote-builder.module.css';

export const MAX_MILESTONES = 12;

/**
 * Section 5: payment term and schedule. The milestones must add up to 100%. The running total is
 * announced politely as it changes; Submit (and Save) refuse a schedule that is off, here and on
 * the server.
 */
export function ScheduleSection({
  paymentTermId,
  paymentTerms,
  milestones,
  errors,
  onTerm,
  onChange,
  onAdd,
  onRemove,
}: {
  paymentTermId: string;
  /** null when the list failed to load. */
  paymentTerms: readonly PaymentTerm[] | null;
  milestones: readonly MilestoneValues[];
  errors: Readonly<Record<string, string>>;
  onTerm: (id: string) => void;
  onChange: (key: string, patch: Partial<MilestoneValues>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  const state = scheduleState(milestones);
  const problem = scheduleMessage(state);

  return (
    <div className={styles.sectionBody}>
      <Field
        label="Payment term"
        hint={
          paymentTerms === null
            ? 'The payment terms did not load. Reload the page to choose one.'
            : "Defaults to the customer's term when left empty."
        }
        error={errors['paymentTermId']}
      >
        {(control) => (
          <Select
            value={paymentTermId}
            onChange={(e) => onTerm(e.target.value)}
            disabled={paymentTerms === null}
            {...control}
          >
            <option value="">Customer default</option>
            {(paymentTerms ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {milestones.length === 0 ? (
        <p className={styles.muted}>
          No milestones. The payment term applies as one payment. Add milestones to split the price,
          for example 60% advance, 20% on delivery, 20% on go-live.
        </p>
      ) : (
        <ol className={styles.milestones} aria-label="Payment milestones">
          {milestones.map((m, index) => {
            const e = (field: string) => errors[`paymentSchedule.${index}.${field}`];
            return (
              <li key={m.key} className={styles.milestone}>
                <Field label={`Milestone ${index + 1}`} error={e('label')}>
                  {(control) => (
                    <Input
                      maxLength={100}
                      value={m.label}
                      onChange={(ev) => onChange(m.key, { label: ev.target.value })}
                      {...control}
                    />
                  )}
                </Field>
                <Field label="Percent" error={e('percent')}>
                  {(control) => (
                    <Input
                      inputMode="decimal"
                      autoComplete="off"
                      className={styles.numInput}
                      value={m.percent}
                      onChange={(ev) => onChange(m.key, { percent: ev.target.value })}
                      {...control}
                    />
                  )}
                </Field>
                <Field label="Due when" hint="Optional" error={e('dueDescription')}>
                  {(control) => (
                    <Input
                      maxLength={200}
                      value={m.dueDescription}
                      onChange={(ev) => onChange(m.key, { dueDescription: ev.target.value })}
                      {...control}
                    />
                  )}
                </Field>
                <Button
                  variant="ghost"
                  onClick={() => onRemove(m.key)}
                  aria-label={`Remove milestone ${index + 1}`}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ol>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onAdd} disabled={milestones.length >= MAX_MILESTONES}>
          Add milestone
        </Button>
        {milestones.length >= MAX_MILESTONES ? (
          <span className={styles.muted}>Up to {MAX_MILESTONES} milestones.</span>
        ) : null}
      </div>

      {milestones.length > 0 ? (
        <p
          role="status"
          aria-live="polite"
          className={styles.scheduleTotal}
          data-state={state.kind}
        >
          {state.kind === 'ok'
            ? 'Milestones add up to 100%.'
            : (problem ?? 'Enter the milestone percentages.')}
        </p>
      ) : null}
      {errors['paymentSchedule'] && problem === null ? (
        <p role="alert" className={styles.rowError}>
          {errors['paymentSchedule']}
        </p>
      ) : null}
    </div>
  );
}
