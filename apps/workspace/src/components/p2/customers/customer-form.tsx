'use client';

import { CURRENCIES, CUSTOMER_RELATIONSHIPS } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/panel';

import type { CustomerFormState } from './form-state';
import type { CustomerField, CustomerValues } from './forms';
import styles from './customer-form.module.css';

const RELATIONSHIP_LABEL: Record<(typeof CUSTOMER_RELATIONSHIPS)[number], string> = {
  prospect: 'Prospect: not buying yet',
  active: 'Active: buying now',
  inactive: 'Inactive: no longer buying',
};

const CURRENCY_LABEL: Record<(typeof CURRENCIES)[number], string> = {
  NPR: 'NPR (Nepalese rupee)',
  INR: 'INR (Indian rupee)',
  USD: 'USD (US dollar)',
};

/** CSS modules type every class as possibly missing; `Field` wants a string. */
const WIDE = styles.wide ?? '';

const REASON_TEXT = {
  pan_vat: 'same PAN/VAT',
  name: 'same name',
} as const;

/**
 * The customer create and edit form. One component for both, because they share fields and rules;
 * the server action passed in decides what happens on submit. Inputs are controlled so a refusal
 * does not wipe what was typed (React 19 resets uncontrolled fields after every action).
 *
 * Create is two steps only when the search finds a possible duplicate: the first submit lists the
 * matches and turns the button into "Create anyway". It warns and never blocks.
 */
export function CustomerForm({
  action,
  initial,
  mode,
  idempotencyKey,
  customerId,
  version,
  cancelHref,
  reloadHref,
}: {
  action: (prev: CustomerFormState, form: FormData) => Promise<CustomerFormState>;
  initial: CustomerValues;
  mode: 'create' | 'edit';
  /** A UUID the server made for this render (create). */
  idempotencyKey?: string;
  /** The customer being edited, and the version the person is looking at. */
  customerId?: string;
  version?: number;
  cancelHref: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(action, {
    key: idempotencyKey ?? '',
    errors: {},
  });
  const [values, setValues] = useState<CustomerValues>(initial);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const set =
    (field: CustomerField) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));

  // Send focus to what needs attention: the summary, else the first field that is wrong.
  useEffect(() => {
    if (state.error || state.duplicates) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const err = state.errors;
  // A duplicate warning only counts for the name and number it was searched with.
  const acknowledged =
    state.duplicates !== undefined &&
    state.checked?.legalName === values.legalName.trim() &&
    state.checked.panVatNo === values.panVatNo.trim();
  const submitLabel = pending
    ? 'Saving'
    : mode === 'edit'
      ? 'Save changes'
      : acknowledged
        ? 'Create anyway'
        : 'Add customer';

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      {mode === 'create' ? (
        <>
          <input type="hidden" name="idempotencyKey" value={state.key} />
          {acknowledged ? <input type="hidden" name="ackDuplicates" value="yes" /> : null}
        </>
      ) : (
        <>
          <input type="hidden" name="customerId" value={customerId} />
          <input type="hidden" name="expectedVersion" value={version} />
        </>
      )}

      {state.error ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title={state.reload ? 'This page is out of date' : 'Nothing was saved'}
          actions={state.reload ? <a href={reloadHref}>Reload this customer</a> : null}
        >
          {state.error}
        </Alert>
      ) : null}

      {state.duplicates ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="warning"
          role="alert"
          title={
            state.duplicates.length === 1
              ? 'This may be a customer you already have'
              : 'These may be customers you already have'
          }
        >
          <ul className={styles.matches}>
            {state.duplicates.map((d) => (
              <li key={d.id} className={styles.match}>
                <a href={`/customers/${encodeURIComponent(d.id)}`} target="_blank" rel="noreferrer">
                  {d.legalName}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>{' '}
                <span className={styles.matchMeta}>
                  {d.number}, {d.reasons.map((r) => REASON_TEXT[r]).join(' and ')}
                </span>
              </li>
            ))}
          </ul>
          <p>If this is a different company, choose Create anyway. Nothing has been saved yet.</p>
        </Alert>
      ) : null}

      <Panel title="Company">
        <div className={styles.grid}>
          <Field label="Legal name" error={err.legalName} className={WIDE}>
            {(control) => (
              <Input
                name="legalName"
                value={values.legalName}
                onChange={set('legalName')}
                maxLength={200}
                autoComplete="organization"
                required
                {...control}
              />
            )}
          </Field>
          <Field
            label="PAN or VAT number"
            hint="Optional. Letters, digits and hyphens."
            error={err.panVatNo}
          >
            {(control) => (
              <Input
                name="panVatNo"
                value={values.panVatNo}
                onChange={set('panVatNo')}
                maxLength={20}
                autoComplete="off"
                className={styles.numeric}
                {...control}
              />
            )}
          </Field>
          <Field label="Industry" hint="Optional." error={err.industry}>
            {(control) => (
              <Input
                name="industry"
                value={values.industry}
                onChange={set('industry')}
                maxLength={100}
                {...control}
              />
            )}
          </Field>
          <Field label="Relationship" error={err.relationship}>
            {(control) => (
              <Select
                name="relationship"
                value={values.relationship}
                onChange={set('relationship')}
                {...control}
              >
                {CUSTOMER_RELATIONSHIPS.map((r) => (
                  <option key={r} value={r}>
                    {RELATIONSHIP_LABEL[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Default currency"
            hint="Used when a quotation does not say otherwise."
            error={err.defaultCurrency}
          >
            {(control) => (
              <Select
                name="defaultCurrency"
                value={values.defaultCurrency}
                onChange={set('defaultCurrency')}
                {...control}
              >
                <option value="">Not set</option>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {CURRENCY_LABEL[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Address">
        <div className={styles.grid}>
          <Field label="Address line 1" error={err.line1} className={WIDE}>
            {(control) => (
              <Input
                name="line1"
                value={values.line1}
                onChange={set('line1')}
                maxLength={200}
                autoComplete="address-line1"
                required
                {...control}
              />
            )}
          </Field>
          <Field label="Address line 2" hint="Optional." error={err.line2} className={WIDE}>
            {(control) => (
              <Input
                name="line2"
                value={values.line2}
                onChange={set('line2')}
                maxLength={200}
                autoComplete="address-line2"
                {...control}
              />
            )}
          </Field>
          <Field label="City" error={err.city}>
            {(control) => (
              <Input
                name="city"
                value={values.city}
                onChange={set('city')}
                maxLength={100}
                autoComplete="address-level2"
                required
                {...control}
              />
            )}
          </Field>
          <Field label="District" hint="Optional." error={err.district}>
            {(control) => (
              <Input
                name="district"
                value={values.district}
                onChange={set('district')}
                maxLength={100}
                {...control}
              />
            )}
          </Field>
          <Field label="Province" hint="Optional." error={err.province}>
            {(control) => (
              <Input
                name="province"
                value={values.province}
                onChange={set('province')}
                maxLength={100}
                autoComplete="address-level1"
                {...control}
              />
            )}
          </Field>
          <Field label="Postal code" hint="Optional." error={err.postalCode}>
            {(control) => (
              <Input
                name="postalCode"
                value={values.postalCode}
                onChange={set('postalCode')}
                maxLength={20}
                autoComplete="postal-code"
                {...control}
              />
            )}
          </Field>
          <Field
            label="Country code"
            hint="Two letters, for example NP, IN or US."
            error={err.country}
          >
            {(control) => (
              <Input
                name="country"
                value={values.country}
                onChange={set('country')}
                maxLength={2}
                autoComplete="country"
                autoCapitalize="characters"
                spellCheck={false}
                className={styles.code}
                required
                {...control}
              />
            )}
          </Field>
        </div>
      </Panel>

      {mode === 'create' ? (
        <Panel
          title="Main contact"
          description="Quotations are sent to this person by email. You can add more contacts later."
        >
          <div className={styles.grid}>
            <Field label="Full name" error={err.contactName}>
              {(control) => (
                <Input
                  name="contactName"
                  value={values.contactName}
                  onChange={set('contactName')}
                  maxLength={200}
                  autoComplete="off"
                  required
                  {...control}
                />
              )}
            </Field>
            <Field label="Email" error={err.contactEmail}>
              {(control) => (
                <Input
                  type="email"
                  name="contactEmail"
                  value={values.contactEmail}
                  onChange={set('contactEmail')}
                  maxLength={254}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  {...control}
                />
              )}
            </Field>
            <Field
              label="Phone"
              hint="Optional. Start with + and the country code, for example +9779812345678."
              error={err.contactPhone}
            >
              {(control) => (
                <Input
                  type="tel"
                  name="contactPhone"
                  value={values.contactPhone}
                  onChange={set('contactPhone')}
                  maxLength={30}
                  autoComplete="off"
                  className={styles.numeric}
                  {...control}
                />
              )}
            </Field>
            <Field label="Job title" hint="Optional." error={err.contactTitle}>
              {(control) => (
                <Input
                  name="contactTitle"
                  value={values.contactTitle}
                  onChange={set('contactTitle')}
                  maxLength={100}
                  autoComplete="off"
                  {...control}
                />
              )}
            </Field>
          </div>
        </Panel>
      ) : null}

      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        <LinkButton href={cancelHref} variant="secondary">
          Cancel
        </LinkButton>
        <span className={styles.status} role="status">
          {pending ? (mode === 'edit' ? 'Saving your changes' : 'Saving the customer') : ''}
        </span>
      </div>
    </form>
  );
}
