'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import styles from '@/app/(app)/leads/leads.module.css';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';

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
  idempotencyKey,
}: {
  action: FormAction;
  sources: { value: string; label: string }[];
  /** Made once per page render on the server; the action hands back the key the next try uses. */
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {
    values: EMPTY,
    fieldErrors: {},
  });
  const [values, setValues] = useState<Record<string, string>>(EMPTY);
  const summary = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  function update(name: string, value: string) {
    setValues((values) => ({ ...values, [name]: value }));
  }
  const set = (name: string) => (e: { target: { value: string } }) => update(name, e.target.value);
  const formId = useId();
  const err = state.fieldErrors;

  useEffect(() => {
    if (state.error) summary.current?.focus();
    else {
      const first = Object.keys(state.fieldErrors)[0];
      if (first) {
        const control = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
        const firstSegment = control?.querySelector<HTMLElement>('[role="spinbutton"]');
        (firstSegment ?? control)?.focus();
        toast.error('Check the highlighted fields.');
      }
    }
  }, [state]);

  return (
    <>
      <PageHeader
        title="Create Lead"
        description="Record an enquiry, its contact details and the next follow-up."
        actions={
          <>
            <LinkButton href="/leads" variant="secondary">
              Cancel
            </LinkButton>
            <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
              {pending ? 'Saving' : 'Save lead'}
            </Button>
          </>
        }
      />
      <form
        id={formId}
        ref={form}
        action={formAction}
        noValidate
        className={styles.form}
        aria-busy={pending || undefined}
      >
        <input type="hidden" name="idempotencyKey" value={state.key ?? idempotencyKey} />

        {state.error ? (
          <Alert ref={summary} tabIndex={-1} tone="error" role="alert">
            {state.error}
          </Alert>
        ) : null}

        <Panel title="Lead overview">
          <Field label="Lead title" error={err['title']}>
            {(c) => (
              <Input
                name="title"
                placeholder="e.g. Inventory and dispatch automation"
                value={values['title']}
                onChange={set('title')}
                maxLength={200}
                required
                {...c}
              />
            )}
          </Field>

          <div className={styles.formGrid}>
            <Field label="Lead source" error={err['source']}>
              {(c) => (
                <Select
                  name="source"
                  value={values['source']}
                  onChange={set('source')}
                  required
                  {...c}
                >
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
        </Panel>

        <Panel title="Prospect and company">
          <div className={styles.formGrid}>
            <Field label="Company or organization" error={err['companyName']}>
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

          <Field
            label="Requirement"
            hint="What they asked for. Optional."
            error={err['requirement']}
          >
            {(c) => (
              <Textarea
                name="requirement"
                rows={3}
                value={values['requirement']}
                onChange={set('requirement')}
                maxLength={5000}
                {...c}
              />
            )}
          </Field>
        </Panel>

        <Panel title="Commercial details">
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
                  {...c}
                />
              )}
            </Field>
            <Field label="Currency" error={err['currency']}>
              {(c) => (
                <Select
                  name="currency"
                  value={values['currency']}
                  onChange={set('currency')}
                  {...c}
                >
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
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  autoComplete="off"
                  value={values['probability']}
                  onChange={set('probability')}
                  {...c}
                />
              )}
            </Field>
            <Field label="Expected close" hint="Optional." error={err['expectedClose']}>
              {(c) => (
                <DatePicker
                  name="expectedClose"
                  value={values['expectedClose']}
                  onChange={(value) => update('expectedClose', value)}
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
        </Panel>
      </form>
    </>
  );
}
