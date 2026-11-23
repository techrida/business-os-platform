'use client';

import { countryName, VENDOR_KINDS, type CountryCode, type VendorKind } from '@bos/contracts';
import { type ReactNode, useActionState, useEffect, useRef, useState } from 'react';

import { AddressFields } from '@/components/ui/address-fields';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { PanInput } from '@/components/ui/pan-input';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';

import type { VendorField, VendorValues } from '../_lib/forms';
import { VENDOR_STATUS_LABEL } from '../_lib/model';
import type { VendorFormState } from '../_lib/state';
import styles from '../vendors.module.css';

const KIND_LABEL: Record<VendorKind, string> = {
  company: 'Company (registered, with a PAN)',
  sole_proprietor: 'Sole proprietor (a person trading under a PAN)',
  individual: 'Individual (a person, with a PAN)',
  foreign: 'Foreign vendor (outside Nepal)',
};

/** CSS modules type every class as possibly missing; `Field` wants a string. */
const WIDE = styles.wide ?? '';

/** Card heading with its Figma eyebrow ("01 · The basics"). The eyebrow is decoration. */
function SectionTitle({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <>
      <span className={styles.eyebrow} aria-hidden="true">
        {eyebrow}
      </span>
      {children}
    </>
  );
}

/**
 * The vendor create and edit form. One component for both, because they share fields and rules;
 * the server action passed in decides what happens on submit. Inputs are controlled so a refusal
 * does not wipe what was typed (React 19 resets uncontrolled fields after every action).
 *
 * Create asks for the kind and country, which are fixed afterwards. Edit locks the legal name and
 * PAN of an approved or suspended vendor (`lockIdentity`): those change through a new KYB review.
 * A foreign vendor has no Nepali PAN: it gets an optional Tax ID in the loose shape instead.
 *
 * The address is optional (street and city together, or neither). Its country is the vendor's
 * country, so the country is asked once, as the address's Country (create), and shown as fixed
 * text on edit.
 *
 * The page header is part of the form, so Cancel and the submit button sit at its top right (Figma
 * "Add Organization" 449:15784); a narrow screen gets them under the form instead.
 */
export function VendorForm({
  action,
  initial,
  mode,
  idempotencyKey,
  vendorId,
  version,
  lockIdentity = false,
  cancelHref,
  reloadHref,
  title,
  description,
}: {
  action: (prev: VendorFormState, form: FormData) => Promise<VendorFormState>;
  initial: VendorValues;
  mode: 'create' | 'edit';
  /** A UUID the server made for this render (create). */
  idempotencyKey?: string;
  /** The vendor being edited, and the version the person is looking at. */
  vendorId?: string;
  version?: number;
  lockIdentity?: boolean;
  cancelHref: string;
  reloadHref: string;
  title: string;
  description?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<VendorFormState, FormData>(action, {
    key: idempotencyKey ?? '',
    errors: {},
  });
  const [values, setValues] = useState<VendorValues>(initial);
  // The PAN box leaves the page while the kind is foreign; whether it was edited stays here, so a
  // short PAN that comes back is still stopped at submit.
  const [panEdited, setPanEdited] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const sameNameRef = useRef<HTMLDivElement>(null);

  const set =
    (field: VendorField) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));

  // Send focus to what needs attention: the summary, the same-name warning (nothing was added, and the
  // person may have pressed the button at the bottom), else the first field that is wrong.
  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else if (state.sameName !== undefined && state.sameName.length > 0)
      sameNameRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const err = state.errors;
  const foreign = values.kind === 'foreign';
  const submitLabel = pending ? 'Saving' : mode === 'edit' ? 'Save changes' : 'Add vendor';

  const actions = (
    <div className={styles.actions}>
      <LinkButton href={cancelHref} variant="secondary">
        Cancel
      </LinkButton>
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </div>
  );

  const legalName = (
    <Field
      label="Legal name"
      hint={
        lockIdentity
          ? 'Locked while the vendor is approved. A change goes through a new KYB review.'
          : undefined
      }
      error={err.legalName}
    >
      {(control) => (
        <Input
          name="legalName"
          value={values.legalName}
          onChange={set('legalName')}
          maxLength={200}
          autoComplete="organization"
          readOnly={lockIdentity}
          required
          {...control}
        />
      )}
    </Field>
  );

  const pan = foreign ? (
    <Field
      label="Tax ID"
      optional
      hint={lockIdentity ? 'Locked while the vendor is approved.' : undefined}
      error={err.pan}
    >
      {(control) => (
        <Input
          name="pan"
          value={values.pan}
          onChange={set('pan')}
          maxLength={20}
          placeholder="GB123456789"
          autoCapitalize="characters"
          spellCheck={false}
          readOnly={lockIdentity}
          {...control}
        />
      )}
    </Field>
  ) : (
    <Field
      label="PAN"
      hint={lockIdentity ? 'Locked while the vendor is approved.' : undefined}
      error={err.pan}
    >
      {(control) => (
        <PanInput
          name="pan"
          value={values.pan}
          onValueChange={(pan) => set('pan')({ target: { value: pan } })}
          placeholder="123456789"
          readOnly={lockIdentity}
          required
          edited={panEdited}
          onEditedChange={setPanEdited}
          {...control}
        />
      )}
    </Field>
  );

  const vat = (
    <label className={styles.check}>
      <input
        type="checkbox"
        name="vatRegistered"
        checked={values.vatRegistered}
        onChange={(e) => setValues((v) => ({ ...v, vatRegistered: e.target.checked }))}
      />
      Registered for VAT
    </label>
  );

  const setAddress = (next: { line: string; city: string; country: CountryCode }): void =>
    setValues((v) => ({
      ...v,
      addressLine: next.line,
      addressCity: next.city,
      country: next.country,
    }));

  // Edit: the country is fixed, so Address and City are built here with the names AddressFields posts.
  const editAddress = (
    <div className={styles.grid}>
      <Field label="Address" optional error={err.addressLine} className={WIDE}>
        {(control) => (
          <Textarea
            {...control}
            name="address.line"
            rows={2}
            maxLength={500}
            autoComplete="street-address"
            value={values.addressLine}
            onChange={set('addressLine')}
          />
        )}
      </Field>
      <Field label="City" optional error={err.addressCity}>
        {(control) => (
          <Input
            {...control}
            name="address.city"
            maxLength={100}
            autoComplete="address-level2"
            value={values.addressCity}
            onChange={set('addressCity')}
          />
        )}
      </Field>
      <Field label="Country" hint="Fixed once the vendor is added.">
        {(control) => (
          <Input {...control} value={countryName(values.country as CountryCode)} readOnly />
        )}
      </Field>
    </div>
  );

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <PageHeader
        title={title}
        description={description}
        actions={<div className={styles.topActions}>{actions}</div>}
      />
      <span className="sr-only" role="status">
        {pending ? (mode === 'edit' ? 'Saving your changes' : 'Saving the vendor') : ''}
      </span>
      {mode === 'create' ? (
        <input type="hidden" name="idempotencyKey" value={state.key} />
      ) : (
        <>
          <input type="hidden" name="vendorId" value={vendorId} />
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
          actions={state.reload ? <a href={reloadHref}>Reload this vendor</a> : null}
        >
          {state.error}
        </Alert>
      ) : null}

      {mode === 'create' && state.sameName !== undefined && state.sameName.length > 0 ? (
        <Alert
          ref={sameNameRef}
          tabIndex={-1}
          tone="warning"
          role="alert"
          title="A vendor with this name already exists"
        >
          Check it is not the same vendor before you add another:
          <ul>
            {state.sameName.map((m) => (
              <li key={m.id}>
                <a href={`/vendors/${encodeURIComponent(m.id)}`} target="_blank" rel="noreferrer">
                  {m.legalName}
                </a>{' '}
                ({VENDOR_STATUS_LABEL[m.status].text})
              </li>
            ))}
          </ul>
          <label className={styles.check}>
            <input
              type="checkbox"
              name="sameNameConfirmed"
              value={state.sameName.map((m) => m.id).join(',')}
            />
            This is a different vendor. Add it anyway.
          </label>
        </Alert>
      ) : null}

      {mode === 'edit' ? (
        // Edit keeps only the fields that can still change, so they share one card and fill its rows.
        <>
          <Panel title={<SectionTitle eyebrow="01 · The basics">Vendor details</SectionTitle>}>
            <div className={styles.grid}>
              {legalName}
              {pan}
            </div>
            {vat}
          </Panel>
          <Panel title={<SectionTitle eyebrow="02 · Address">Address</SectionTitle>}>
            {editAddress}
          </Panel>
        </>
      ) : (
        <>
          <Panel title={<SectionTitle eyebrow="01 · The basics">Vendor details</SectionTitle>}>
            <div className={styles.grid}>
              {legalName}
              <Field label="Trade name" optional error={err.tradeName}>
                {(control) => (
                  <Input
                    name="tradeName"
                    value={values.tradeName}
                    onChange={set('tradeName')}
                    maxLength={200}
                    {...control}
                  />
                )}
              </Field>
              <Field
                label="Kind"
                hint="Fixed once the vendor is added."
                error={err.kind}
                className={WIDE}
              >
                {(control) => (
                  <Select name="kind" value={values.kind} onChange={set('kind')} {...control}>
                    {VENDOR_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </Panel>
          <Panel
            title={<SectionTitle eyebrow="02 · Tax registration">Tax registration</SectionTitle>}
          >
            <div className={styles.grid}>{pan}</div>
            {vat}
          </Panel>
          <Panel title={<SectionTitle eyebrow="03 · Address">Address</SectionTitle>}>
            <AddressFields
              name="address"
              value={{
                line: values.addressLine,
                city: values.addressCity,
                country: values.country as CountryCode,
              }}
              onChange={setAddress}
              errors={{ line: err.addressLine, city: err.addressCity, country: err.country }}
              hints={{
                country: foreign
                  ? 'The vendor’s own country, outside Nepal. Fixed once the vendor is added.'
                  : 'Vendors in Nepal use Nepal. Fixed once the vendor is added.',
              }}
            />
          </Panel>
        </>
      )}

      <div className={styles.bottomActions}>{actions}</div>
    </form>
  );
}
