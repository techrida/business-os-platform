'use client';

import { CURRENCIES, type SettingKey } from '@bos/contracts';
import { useActionState, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';

import { IDLE, type ActionState } from '../action-state';
import { FormStatus } from '../ui';
import { saveSettingAction } from './actions';
import styles from './settings.module.css';

// One row per setting key: the current value and an Edit button; Edit opens the form. The control
// depends on the value's shape: a list of currencies is checkboxes, the SLA object is JSON text,
// and the rest are short text fields. The Server Action validates against the shared SETTINGS
// schema, and the API validates again.
//
// It renders the row's cells (value, button, form, status) as siblings: the page's list item is
// the grid they sit in.
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
  const [editing, setEditing] = useState(false);
  // A saved value closes the editor; the new value shows in the row after the page refreshes.
  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData): Promise<ActionState> => {
      const next = await saveSettingAction(previous, formData);
      if (next.status === 'ok') setEditing(false);
      return next;
    },
    IDLE,
  );
  const kept = state.status === 'error' ? (state.fields?.value ?? null) : null;
  const id = `setting-${settingKey.replace(/[^a-z0-9]+/gi, '-')}`;
  const formId = `${id}-form`;

  let control: ReactNode;
  if (settingKey === 'currency.enabled') {
    const on = (kept ?? current).split(/,\s*/);
    control = (
      <fieldset
        className={styles.fieldset}
        aria-invalid={state.fieldErrors?.value ? true : undefined}
        aria-describedby={state.fieldErrors?.value ? `${id}-error` : undefined}
      >
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
        {state.fieldErrors?.value && (
          <p id={`${id}-error`} className={styles.fieldError}>
            {state.fieldErrors.value}
          </p>
        )}
      </fieldset>
    );
  } else if (settingKey === 'approvals.sla_defaults') {
    control = (
      <Field label={`${label} (JSON)`} error={state.fieldErrors?.value}>
        {(field) => (
          <Textarea
            name="value"
            rows={7}
            spellCheck={false}
            className={styles.jsonField}
            defaultValue={kept ?? current}
            {...field}
          />
        )}
      </Field>
    );
  } else {
    control = (
      <Field label={label} error={state.fieldErrors?.value}>
        {(field) => (
          <Input
            name="value"
            {...(settingKey === 'tax.vat_rate'
              ? { type: 'number', min: 0, max: 100, step: '0.01' }
              : {})}
            autoComplete="off"
            required
            defaultValue={kept ?? current}
            {...field}
          />
        )}
      </Field>
    );
  }

  return (
    <>
      <div className={styles.value}>
        {current.includes('\n') ? (
          <pre
            className={styles.json}
            role="region"
            aria-label={`${label}, current value`}
            tabIndex={0}
          >
            {current}
          </pre>
        ) : (
          current
        )}
      </div>
      <div className={styles.rowAction}>
        <Button
          variant="secondary"
          size="small"
          aria-expanded={editing}
          aria-controls={editing ? formId : undefined}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? 'Cancel' : 'Edit'}
          <span className="sr-only"> {label}</span>
        </Button>
      </div>
      {editing ? (
        <form id={formId} action={formAction} className={`${styles.rowForm} ${styles.editForm}`}>
          <input type="hidden" name="key" value={settingKey} />
          {control}
          <div className={styles.actions}>
            <Button type="submit" size="small" disabled={pending}>
              Save
            </Button>
          </div>
        </form>
      ) : null}
      <FormStatus state={state} pending={pending} />
    </>
  );
}
