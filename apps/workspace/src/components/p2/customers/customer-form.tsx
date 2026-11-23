'use client';

import {
  CUSTOMER_RELATIONSHIPS,
  DEFAULT_COUNTRY,
  isCountryCode,
  type CountryCode,
  type Currency,
  type PartyPhoneInput,
} from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { AddressFields, type AddressValue } from '@/components/ui/address-fields';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { CountrySelect } from '@/components/ui/country-select';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { PanInput } from '@/components/ui/pan-input';
import { PhoneListInput } from '@/components/ui/phone-list-input';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { currencyChoices } from '@/lib/enabled-currencies';

import type { CustomerFormState } from './form-state';
import type { CustomerField, CustomerValues } from './forms';
import styles from './customer-form.module.css';

const RELATIONSHIP_LABEL: Record<(typeof CUSTOMER_RELATIONSHIPS)[number], string> = {
  prospect: 'Prospect',
  active: 'Active',
  inactive: 'Inactive',
};

/** The form holds countries as text; the pickers take a code, and every saved value is one. */
const countryOf = (value: string): CountryCode => {
  const code = value.trim().toUpperCase();
  return isCountryCode(code) ? code : DEFAULT_COUNTRY;
};

const REASON_MAX = 500;
const REASON_REQUIRED = `Say why this is a different organization, up to ${REASON_MAX} characters.`;

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
  description,
  enabledCurrencies,
  lockIdentity = false,
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
  description?: string;
  /**
   * The tenant's enabled currencies (`loadEnabledCurrencies`). The default currency seeds new
   * documents, so only these are offered; on edit the organization's own saved currency stays
   * listed even after it was switched off, so the form never silently changes it.
   */
  enabledCurrencies: readonly Currency[];
  /** A verified customer's legal name, PAN and country are read-only (R6AE); the API refuses an edit of them. */
  lockIdentity?: boolean;
}) {
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(action, {
    key: idempotencyKey ?? '',
    errors: {},
  });
  const [values, setValues] = useState<CustomerValues>(initial);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // A Nepal customer's PAN or VAT number is nine digits. The contract also takes the tax ids of
  // customers abroad (letters, digits, hyphens), so only a Nepal customer gets the digits-only box.
  const nepalCustomer = values.country.trim().toUpperCase() === 'NP';
  // The PAN box leaves the page when the country is not Nepal; whether it was edited stays here, so a
  // short PAN that comes back is still stopped at submit.
  const [panEdited, setPanEdited] = useState(false);
  const set =
    (field: CustomerField) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));

  // The first contact usually lives where the company does, so their country follows the address
  // country until the person picks one for the contact; after that it stays as picked.
  const [contactCountryChosen, setContactCountryChosen] = useState(false);
  const setAddress = (address: AddressValue): void =>
    setValues((v) => ({
      ...v,
      line: address.line,
      city: address.city,
      country: address.country,
      contactCountry: contactCountryChosen ? v.contactCountry : address.country,
    }));

  // React 19 resets the form after every action, the duplicate warning included. The phone list
  // restores its default on a reset, so the default is the valid numbers typed so far.
  const [phones, setPhones] = useState<PartyPhoneInput[]>([]);

  // "Create anyway" asks why first (F1-Q55): the reason is audited with the organizations it matched.
  const reasonFieldRef = useRef<HTMLTextAreaElement>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();

  // Send focus to what needs attention: the summary, else the first field that is wrong.
  useEffect(() => {
    if (state.error || state.duplicates) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  // The API asked for a reason (a same-name or same-PAN organization it knows of): ask for it straight away.
  // Adjusted while rendering, once per answer, rather than in an effect.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    if (state.needsReason) {
      setReasonError(undefined);
      setReasonOpen(true);
    }
  }

  const err = state.errors;
  const currencies = currencyChoices(enabledCurrencies, initial.defaultCurrency);
  const offCurrency = currencies.find((c) => !c.enabled && c.value === values.defaultCurrency);
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
        : 'Create Organization';

  function confirmCreateAnyway() {
    const why = reason.trim();
    if (why === '' || why.length > REASON_MAX) {
      setReasonError(REASON_REQUIRED);
      reasonFieldRef.current?.focus();
      return;
    }
    setReasonOpen(false);
    formRef.current?.requestSubmit();
  }

  const actions = (
    <div className={styles.actions}>
      <LinkButton href={cancelHref} variant="secondary">
        Cancel
      </LinkButton>
      {acknowledged && !pending ? (
        <Button
          type="button"
          onClick={() => {
            setReasonError(undefined);
            setReasonOpen(true);
          }}
        >
          Create anyway
        </Button>
      ) : (
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      )}
    </div>
  );

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <PageHeader
        title={mode === 'create' ? 'Create Organization' : 'Edit Organization'}
        description={description}
        actions={<div className={styles.topActions}>{actions}</div>}
      />
      <span className="sr-only" role="status">
        {pending ? 'Saving the organization' : ''}
      </span>
      {mode === 'create' ? (
        <>
          <input type="hidden" name="idempotencyKey" value={state.key} />
          {acknowledged ? (
            <>
              <input type="hidden" name="ackDuplicates" value="yes" />
              <input type="hidden" name="duplicateOverrideReason" value={reason.trim()} />
            </>
          ) : null}
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
          actions={state.reload ? <a href={reloadHref}>Reload this organization</a> : null}
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
            state.duplicates.length === 0
              ? 'An organization with this name or PAN/VAT number already exists'
              : state.duplicates.length === 1
                ? 'This may be an organization you already have'
                : 'These may be organizations you already have'
          }
        >
          {state.duplicates.length > 0 ? (
            <ul className={styles.matches}>
              {state.duplicates.map((d) => (
                <li key={d.id} className={styles.match}>
                  <a
                    href={`/customers/${encodeURIComponent(d.id)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {d.legalName}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>{' '}
                  <span className={styles.matchMeta}>
                    {d.number}, {d.reasons.map((r) => REASON_TEXT[r]).join(' and ')}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p>
            If this is a different company, choose Create anyway and say why. Nothing has been saved
            yet.
          </p>
        </Alert>
      ) : null}

      <Panel title="Basic Company Information" className={styles.formSection}>
        <div className={styles.grid}>
          <Field
            label="Organization legal name"
            hint={
              lockIdentity
                ? 'Locked: the legal name of a verified customer cannot be edited.'
                : undefined
            }
            error={err.legalName}
            className={WIDE}
          >
            {(control) => (
              <Input
                name="legalName"
                value={values.legalName}
                onChange={set('legalName')}
                maxLength={200}
                autoComplete="organization"
                placeholder="e.g. Acme Technologies Corporation"
                readOnly={lockIdentity}
                required
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
        </div>
      </Panel>

      {mode === 'create' ? (
        <Panel
          title="Primary Contact"
          className={styles.formSection}
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
            <Field label="Contact country" error={err.contactCountry}>
              {(control) => (
                <CountrySelect
                  id={control.id}
                  aria-labelledby={control['aria-labelledby']}
                  aria-describedby={control['aria-describedby']}
                  aria-invalid={control['aria-invalid']}
                  name="contactCountry"
                  required
                  value={countryOf(values.contactCountry)}
                  onChange={(country) => {
                    setContactCountryChosen(true);
                    setValues((v) => ({ ...v, contactCountry: country }));
                  }}
                />
              )}
            </Field>
            <Field
              label="Phone"
              hint="Optional. Pick each number's country, or type + and its code."
              className={WIDE}
            >
              {(control) => (
                <PhoneListInput
                  name="contactPhones"
                  aria-labelledby={control['aria-labelledby']}
                  aria-describedby={control['aria-describedby']}
                  defaultValue={phones}
                  defaultCountry={countryOf(values.contactCountry)}
                  rowErrors={err.phoneRows}
                  error={err.phones}
                  onChange={setPhones}
                />
              )}
            </Field>
          </div>
        </Panel>
      ) : null}

      <Panel title="Business Address" className={styles.formSection}>
        <AddressFields
          name="address"
          required
          value={{ line: values.line, city: values.city, country: countryOf(values.country) }}
          onChange={setAddress}
          errors={{ line: err.line, city: err.city, country: err.country }}
          countryDisabled={lockIdentity}
          {...(lockIdentity && {
            hints: { country: 'Locked: the country of a verified customer cannot be edited.' },
          })}
        />
      </Panel>

      <Panel title="Commercial & Compliance" className={styles.formSection}>
        <div className={styles.grid}>
          <Field
            label="Default currency"
            hint={
              offCurrency
                ? `${offCurrency.label} is switched off in Settings. It stays until you pick another currency.`
                : 'Used when a quotation does not say otherwise.'
            }
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
                {currencies.map((c) => (
                  <option key={c.value} value={c.value} disabled={!c.enabled}>
                    {c.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="PAN or VAT number"
            hint={
              lockIdentity
                ? 'Locked: the PAN of a verified customer cannot be edited.'
                : nepalCustomer
                  ? 'Optional. Nine digits.'
                  : 'Optional. Letters, digits and hyphens, for a customer outside Nepal.'
            }
            error={err.panVatNo}
          >
            {(control) =>
              nepalCustomer ? (
                <PanInput
                  name="panVatNo"
                  value={values.panVatNo}
                  onValueChange={(pan) => set('panVatNo')({ target: { value: pan } })}
                  edited={panEdited}
                  onEditedChange={setPanEdited}
                  readOnly={lockIdentity}
                  {...control}
                />
              ) : (
                <Input
                  name="panVatNo"
                  value={values.panVatNo}
                  onChange={(e) => {
                    // The same number reaches the PAN box if the country becomes Nepal; an edit made
                    // here must count there too, or a short PAN typed abroad is never stopped.
                    setPanEdited(true);
                    set('panVatNo')(e);
                  }}
                  maxLength={20}
                  autoComplete="off"
                  className={styles.numeric}
                  readOnly={lockIdentity}
                  {...control}
                />
              )
            }
          </Field>
        </div>
      </Panel>
      <div className={styles.bottomActions}>{actions}</div>

      {mode === 'create' ? (
        <Dialog
          open={reasonOpen}
          onOpenChange={setReasonOpen}
          title="Create anyway?"
          description={`Say why ${values.legalName.trim() || 'this'} is a different organization from the possible duplicates. The reason is kept in the audit log.`}
          size="small"
          closeOnOutsideClick={false}
          initialFocusRef={reasonFieldRef}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button onClick={confirmCreateAnyway}>Create anyway</Button>
            </>
          }
        >
          <Field label="Reason" error={reasonError}>
            {(control) => (
              <Textarea
                ref={reasonFieldRef}
                rows={3}
                maxLength={REASON_MAX}
                required
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(undefined);
                }}
                {...control}
              />
            )}
          </Field>
        </Dialog>
      ) : null}
    </form>
  );
}
