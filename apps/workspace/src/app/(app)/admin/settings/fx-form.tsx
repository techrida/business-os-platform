'use client';

import { useActionState } from 'react';

import styles from '../admin.module.css';
import { IDLE } from '../action-state';
import { FormStatus } from '../ui';
import { addFxRateAction } from './actions';

export function FxForm({ today }: { today: string }) {
  const [state, formAction, pending] = useActionState(addFxRateAction, IDLE);
  const kept = state.status === 'error' ? (state.fields ?? {}) : {};

  return (
    <form action={formAction} className={styles.form}>
      <div className={styles.formRow}>
        <div className={styles.field}>
          <label htmlFor="fx-currency">Currency</label>
          <select
            id="fx-currency"
            className={styles.select}
            name="currency"
            defaultValue={kept.currency ?? 'USD'}
          >
            <option value="USD">USD</option>
            <option value="INR">INR</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="fx-rate">Rate (NPR for 1 unit)</label>
          <input
            id="fx-rate"
            className={styles.input}
            name="rateNpr"
            inputMode="decimal"
            autoComplete="off"
            required
            pattern="\d{1,12}(\.\d{1,6})?"
            title="A number with up to 6 decimals, for example 133.5"
            aria-describedby="fx-rate-hint"
            defaultValue={kept.rateNpr ?? ''}
          />
          <span id="fx-rate-hint" className={styles.hint}>
            Up to 6 decimals.
          </span>
        </div>
        <div className={styles.field}>
          <label htmlFor="fx-date">Applies from</label>
          <input
            id="fx-date"
            className={styles.input}
            type="date"
            name="rateDate"
            required
            defaultValue={kept.rateDate ?? today}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="fx-source">Source</label>
          <input
            id="fx-source"
            className={styles.input}
            name="source"
            autoComplete="off"
            placeholder="manual"
            defaultValue={kept.source ?? ''}
          />
        </div>
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          Add rate
        </button>
        <FormStatus state={state} pending={pending} />
      </div>
    </form>
  );
}
