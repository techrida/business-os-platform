'use client';

import { VENDOR_KINDS, type VendorKind } from '@bos/contracts';
import { type ReactNode, useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
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
 * A foreign vendor has no Nepali PAN, so the field goes away when that kind is chosen.
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
      // Alone on its row (an edit of a foreign vendor), it takes the whole row.
      {...(mode === 'edit' && foreign ? { className: WIDE } : {})}
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

  const pan = foreign ? null : (
    <Field
      label="PAN"
      hint={
        lockIdentity
          ? 'Locked while the vendor is approved.'
          : 'Nine digits. Every vendor except a foreign one needs it.'
      }
      error={err.pan}
    >
      {(control) => (
        <PanInput
          name="pan"
          value={values.pan}
          onValueChange={(pan) => set('pan')({ target: { value: pan } })}
          readOnly={lockIdentity}
          required
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
        <Panel title={<SectionTitle eyebrow="01 · The basics">Vendor details</SectionTitle>}>
          <div className={styles.grid}>
            {legalName}
            {pan}
          </div>
          {vat}
        </Panel>
      ) : (
        <>
          <Panel title={<SectionTitle eyebrow="01 · The basics">Vendor details</SectionTitle>}>
            <div className={styles.grid}>
              {legalName}
              <Field
                label="Trade name"
                hint="Optional. The name the vendor is known by."
                error={err.tradeName}
              >
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
            <div className={styles.grid}>
              {pan}
              <Field
                label="Country code"
                hint={
                  foreign
                    ? 'Two letters, the vendor’s own country, for example IN or US.'
                    : 'Two letters. Vendors in Nepal use NP.'
                }
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
            {vat}
          </Panel>
        </>
      )}

      <div className={styles.bottomActions}>{actions}</div>
    </form>
  );
}
