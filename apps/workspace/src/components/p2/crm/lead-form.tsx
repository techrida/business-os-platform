'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';

import styles from './crm.module.css';
import type { FormAction, FormState } from './types';

const CURRENCIES = [
  { value: 'NPR', label: 'NPR (Nepalese rupee)' },
  { value: 'INR', label: 'INR (Indian rupee)' },
  { value: 'USD', label: 'USD (US dollar)' },
];

const EMPTY: Record<string, string> = {
  title: '',
  source: '',
  campaign: '',
  companyName: '',
  contactName: '',
  email: '',
  phone: '',
  requirement: '',
  expectedValue: '',
  currency: 'NPR',
  probability: '',
  expectedClose: '',
  nextFollowUpAt: '',
  notes: '',
};

/** The new-lead form. Inputs are controlled so a refusal does not wipe what was typed. */
export function LeadForm({
  action,
  sources,
}: {
  action: FormAction;
  sources: { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {
    values: EMPTY,
    fieldErrors: {},
  });
  const [values, setValues] = useState<Record<string, string>>(EMPTY);
  const summary = useRef<HTMLDivElement>(null);
  const set = (name: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [name]: e.target.value }));
  const err = state.fieldErrors;

  useEffect(() => {
    if (state.error) summary.current?.focus();
    else {
      const first = Object.keys(state.fieldErrors)[0];
      if (first) document.getElementsByName(first)[0]?.focus();
    }
  }, [state]);

  return (
    <form action={formAction} noValidate className={styles.form}>
      {state.error ? (
        <Alert ref={summary} tabIndex={-1} tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}

      <Field label="Title" hint="What the lead is about, in a few words." error={err['title']}>
        {(c) => (
          <Input
            name="title"
            value={values['title']}
            onChange={set('title')}
            maxLength={200}
            required
            {...c}
          />
        )}
      </Field>

      <div className={styles.formGrid}>
        <Field label="Source" error={err['source']}>
          {(c) => (
            <Select name="source" value={values['source']} onChange={set('source')} required {...c}>
              <option value="">Choose a source</option>
              {sources.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Campaign" hint="Optional." error={err['campaign']}>
          {(c) => (
            <Input
              name="campaign"
              value={values['campaign']}
              onChange={set('campaign')}
              maxLength={100}
              {...c}
            />
          )}
        </Field>
      </div>

      <div className={styles.formGrid}>
        <Field label="Company" error={err['companyName']}>
          {(c) => (
            <Input
              name="companyName"
              value={values['companyName']}
              onChange={set('companyName')}
              maxLength={200}
              required
              {...c}
            />
          )}
        </Field>
        <Field label="Contact person" error={err['contactName']}>
          {(c) => (
            <Input
              name="contactName"
              value={values['contactName']}
              onChange={set('contactName')}
              maxLength={200}
              required
              {...c}
            />
          )}
        </Field>
        <Field label="Email" hint="Optional." error={err['email']}>
          {(c) => (
            <Input
              name="email"
              type="email"
              autoComplete="off"
              value={values['email']}
              onChange={set('email')}
              {...c}
            />
          )}
        </Field>
        <Field
          label="Phone"
          hint="Optional. With the country code, for example +9779812345678."
          error={err['phone']}
        >
          {(c) => (
            <Input
              name="phone"
              type="tel"
              autoComplete="off"
              value={values['phone']}
              onChange={set('phone')}
              {...c}
            />
          )}
        </Field>
      </div>

      <Field label="Requirement" hint="What they asked for. Optional." error={err['requirement']}>
        {(c) => (
          <Textarea
            name="requirement"
            rows={4}
            value={values['requirement']}
            onChange={set('requirement')}
            maxLength={5000}
            {...c}
          />
        )}
      </Field>

      <div className={styles.formGrid}>
        <Field
          label="Expected value"
          hint="Optional. For example 12,50,000."
          error={err['expectedValue']}
        >
          {(c) => (
            <Input
              name="expectedValue"
              inputMode="decimal"
              autoComplete="off"
              value={values['expectedValue']}
              onChange={set('expectedValue')}
              className={styles.num}
              {...c}
            />
          )}
        </Field>
        <Field label="Currency" error={err['currency']}>
          {(c) => (
            <Select name="currency" value={values['currency']} onChange={set('currency')} {...c}>
              {CURRENCIES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Probability (%)" hint="Optional. 0 to 100." error={err['probability']}>
          {(c) => (
            <Input
              name="probability"
              inputMode="numeric"
              autoComplete="off"
              value={values['probability']}
              onChange={set('probability')}
              {...c}
            />
          )}
        </Field>
        <Field label="Expected close" hint="Optional." error={err['expectedClose']}>
          {(c) => (
            <Input
              name="expectedClose"
              type="date"
              value={values['expectedClose']}
              onChange={set('expectedClose')}
              {...c}
            />
          )}
        </Field>
        <Field
          label="Next follow-up"
          hint="Optional. Kathmandu time."
          error={err['nextFollowUpAt']}
        >
          {(c) => (
            <Input
              name="nextFollowUpAt"
              type="datetime-local"
              value={values['nextFollowUpAt']}
              onChange={set('nextFollowUpAt')}
              {...c}
            />
          )}
        </Field>
      </div>

      <Field label="Notes" hint="Optional." error={err['notes']}>
        {(c) => (
          <Textarea
            name="notes"
            rows={3}
            value={values['notes']}
            onChange={set('notes')}
            maxLength={5000}
            {...c}
          />
        )}
      </Field>

      <div className={styles.formActions}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving' : 'Save lead'}
        </Button>
        <LinkButton href="/leads" variant="secondary">
          Cancel
        </LinkButton>
      </div>
    </form>
  );
}
