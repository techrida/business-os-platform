'use client';

import { CURRENCIES, type SettingKey } from '@bos/contracts';
import { useActionState, type ReactNode } from 'react';

import styles from '../admin.module.css';
import { IDLE } from '../action-state';
import { FormStatus } from '../ui';
import { saveSettingAction } from './actions';

// One form per setting key. The control depends on the value's shape: a list of currencies is
// checkboxes, the SLA object is JSON text, and the rest are short text fields. The Server Action
// validates against the shared SETTINGS schema, and the API validates again.
export function SettingForm({
  settingKey,
  label,
  current,
}: {
  settingKey: SettingKey;
  label: string;
  /** The saved value as text: a string, comma-separated list, or pretty JSON. */
  current: string;
}) {
  const [state, formAction, pending] = useActionState(saveSettingAction, IDLE);
  const kept = state.status === 'error' ? (state.fields?.value ?? null) : null;
  const id = `setting-${settingKey.replace(/[^a-z0-9]+/gi, '-')}`;

  let control: ReactNode;
  if (settingKey === 'currency.enabled') {
    const on = (kept ?? current).split(/,\s*/);
    control = (
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{label}</legend>
        <div className={styles.checkGrid}>
          {CURRENCIES.map((currency) =>
            currency === 'NPR' ? (
              <label key={currency} className={styles.checkLabel} htmlFor={`${id}-NPR`}>
                {/* NPR is the books currency and cannot be switched off. A disabled box is not sent,
                    so the hidden field carries the value. */}
                <input
                  id={`${id}-NPR`}
                  className={styles.checkbox}
                  type="checkbox"
                  checked
                  disabled
                />
                <input type="hidden" name="value" value="NPR" />
                NPR (always on)
              </label>
            ) : (
              <label key={currency} className={styles.checkLabel} htmlFor={`${id}-${currency}`}>
                <input
                  id={`${id}-${currency}`}
                  className={styles.checkbox}
                  type="checkbox"
                  name="value"
                  value={currency}
                  defaultChecked={on.includes(currency)}
                />
                {currency}
              </label>
            ),
          )}
        </div>
      </fieldset>
    );
  } else if (settingKey === 'approvals.sla_defaults') {
    control = (
      <div className={styles.field}>
        <label htmlFor={id}>{label} (JSON)</label>
        <textarea
          id={id}
          className={styles.textarea}
          name="value"
          rows={7}
          spellCheck={false}
          defaultValue={kept ?? current}
        />
      </div>
    );
  } else {
    control = (
      <div className={styles.field}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className={styles.input}
          name="value"
          autoComplete="off"
          required
          defaultValue={kept ?? current}
        />
      </div>
    );
  }

  return (
    <form action={formAction} className={styles.stack}>
      <input type="hidden" name="key" value={settingKey} />
      {control}
      <div className={styles.actions}>
        <button type="submit" className={`${styles.btn} ${styles.btnSmall}`} disabled={pending}>
          Save
        </button>
        <FormStatus state={state} pending={pending} />
      </div>
    </form>
  );
}
