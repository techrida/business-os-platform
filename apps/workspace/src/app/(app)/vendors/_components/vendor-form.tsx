'use client';

import { VENDOR_KINDS, type VendorKind } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/panel';

import type { VendorField, VendorValues } from '../_lib/forms';
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

/**
 * The vendor create and edit form. One component for both, because they share fields and rules;
 * the server action passed in decides what happens on submit. Inputs are controlled so a refusal
 * does not wipe what was typed (React 19 resets uncontrolled fields after every action).
 *
 * Create asks for the kind and country, which are fixed afterwards. Edit locks the legal name and
 * PAN of an approved or suspended vendor (`lockIdentity`): those change through a new KYB review.
 * A foreign vendor has no Nepali PAN, so the field goes away when that kind is chosen.
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
}) {
  const [state, formAction, pending] = useActionState<VendorFormState, FormData>(action, {
    key: idempotencyKey ?? '',
    errors: {},
  });
  const [values, setValues] = useState<VendorValues>(initial);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const set =
    (field: VendorField) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));

  // Send focus to what needs attention: the summary, else the first field that is wrong.
  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const err = state.errors;
  const foreign = values.kind === 'foreign';
  const submitLabel = pending ? 'Saving' : mode === 'edit' ? 'Save changes' : 'Add vendor';

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
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

      <Panel title="Vendor details">
        <div className={styles.grid}>
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
          {mode === 'create' ? (
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
          ) : null}
          {mode === 'create' ? (
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
          ) : null}
        </div>
      </Panel>
      <Panel title="Tax registration">
        <div className={styles.grid}>
          {foreign ? null : (
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
                <Input
                  name="pan"
                  value={values.pan}
                  onChange={set('pan')}
                  inputMode="numeric"
                  maxLength={9}
                  autoComplete="off"
                  className={styles.numeric}
                  readOnly={lockIdentity}
                  required
                  {...control}
                />
              )}
            </Field>
          )}
          {mode === 'create' ? (
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
          ) : null}
        </div>
        <label className={styles.check}>
          <input
            type="checkbox"
            name="vatRegistered"
            checked={values.vatRegistered}
            onChange={(e) => setValues((v) => ({ ...v, vatRegistered: e.target.checked }))}
          />
          Registered for VAT
        </label>
      </Panel>

      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        <LinkButton href={cancelHref} variant="secondary">
          Cancel
        </LinkButton>
        <span className={styles.status} role="status">
          {pending ? (mode === 'edit' ? 'Saving your changes' : 'Saving the vendor') : ''}
        </span>
      </div>
    </form>
  );
}
