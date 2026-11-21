'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { PhoneInput } from '@/components/ui/phone-input';
import { toast } from '@/components/ui/toast';

import type { ContactFormState } from './form-state';
import { EMPTY_CONTACT_VALUES, type ContactField, type ContactValues } from './forms';
import styles from './customer-form.module.css';

/** Why the main-contact box is off, linked to it with aria-describedby. */
export const PRIMARY_TAKEN_REASON = 'This customer already has a main contact.';

/**
 * Add a contact to a customer. Drafts belong to the current save count, so a successful save
 * clears the fields while a refusal keeps what was typed.
 * A save and a lost race for the main contact are transient, so they are toasts; a refusal that
 * blocks the save stays on the form.
 */
export function ContactForm({
  action,
  customerId,
  idempotencyKey,
  hasPrimary,
  requireEmail,
  inDialog = false,
}: {
  action: (prev: ContactFormState, form: FormData) => Promise<ContactFormState>;
  customerId: string;
  /** A UUID the server made for this render. */
  idempotencyKey: string;
  /** The customer already has a main contact, so this one cannot be made the main one. */
  hasPrimary: boolean;
  /** The customer has no contact with an email yet, so this one needs an email. */
  requireEmail: boolean;
  inDialog?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ContactFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
    savedCount: 0,
  });
  const formId = useId();
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [draft, setDraft] = useState({ savedCount: 0, values: EMPTY_CONTACT_VALUES });
  const values = draft.savedCount === state.savedCount ? draft.values : EMPTY_CONTACT_VALUES;
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.saved) toast.success(state.saved);
    if (state.primaryTaken) toast.error(state.primaryTaken);
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const submit = (
    <Button
      type="submit"
      form={formId}
      variant={inDialog ? 'primary' : 'secondary'}
      disabled={pending}
    >
      {pending ? 'Saving' : 'Add contact'}
    </Button>
  );
  const form = (
    <form id={formId} ref={formRef} action={formAction} noValidate className={styles.contactForm}>
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />
      {requireEmail ? <input type="hidden" name="requireEmail" value="yes" /> : null}

      {state.error ? (
        <Alert ref={summaryRef} tabIndex={-1} tone="error" role="alert" title="Contact not saved">
          {state.error}
        </Alert>
      ) : null}
      <ContactFields
        // A saved contact empties the form; fresh fields also drop the phone's other-country switch.
        key={state.savedCount}
        values={values}
        onChange={(next) => setDraft({ savedCount: state.savedCount, values: next })}
        errors={state.errors}
        hasPrimary={hasPrimary}
        requireEmail={requireEmail}
      />

      {inDialog ? null : <div className={styles.actions}>{submit}</div>}
    </form>
  );

  if (!inDialog) return form;

  return (
    <Dialog
      trigger={
        <Button variant="tertiary" size="small">
          <span aria-hidden="true" className={styles.plus}>
            +
          </span>
          Add Contact
        </Button>
      }
      title="Add Contact"
      open={openedAt === state.savedCount}
      onOpenChange={(open) => setOpenedAt(open ? state.savedCount : null)}
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Close
            </Button>
          </DialogClose>
          {submit}
        </>
      }
    >
      {form}
    </Dialog>
  );
}

function ContactFields({
  values,
  onChange,
  errors,
  hasPrimary,
  requireEmail,
}: {
  values: ContactValues;
  onChange: (values: ContactValues) => void;
  errors: ContactFormState['errors'];
  hasPrimary: boolean;
  requireEmail: boolean;
}) {
  const primaryReasonId = useId();
  // Never send a tick the page knows is refused (the box was ticked before the page reloaded).
  const isPrimary = values.isPrimary && !hasPrimary;
  const set =
    (field: ContactField) =>
    (e: { target: { value: string } }): void =>
      onChange({ ...values, [field]: e.target.value });

  return (
    <>
      <div className={styles.grid}>
        <Field label="Full name" error={errors.fullName}>
          {(control) => (
            <Input
              name="fullName"
              value={values.fullName}
              onChange={set('fullName')}
              maxLength={200}
              autoComplete="off"
              required
              {...control}
            />
          )}
        </Field>
        <Field label="Job title" hint="Optional." error={errors.title}>
          {(control) => (
            <Input
              name="title"
              value={values.title}
              onChange={set('title')}
              maxLength={100}
              autoComplete="off"
              {...control}
            />
          )}
        </Field>
        <Field
          label="Email"
          hint={requireEmail ? 'Required: quotations are sent to it.' : 'Optional.'}
          error={errors.email}
        >
          {(control) => (
            <Input
              type="email"
              name="email"
              value={values.email}
              onChange={set('email')}
              maxLength={254}
              autoComplete="off"
              spellCheck={false}
              required={requireEmail}
              {...control}
            />
          )}
        </Field>
        <Field
          label="Phone"
          hint="Optional. Nepal numbers need only the digits."
          error={errors.phone}
        >
          {(control) => (
            <PhoneInput
              name="phone"
              value={values.phone}
              onValueChange={(phone) => set('phone')({ target: { value: phone } })}
              {...control}
            />
          )}
        </Field>
      </div>
      <label className={styles.check}>
        <input
          type="checkbox"
          name="isPrimary"
          checked={isPrimary}
          disabled={hasPrimary}
          aria-describedby={hasPrimary ? primaryReasonId : undefined}
          onChange={(e) => onChange({ ...values, isPrimary: e.target.checked })}
        />
        Make this the main contact
      </label>
      {hasPrimary ? (
        <p id={primaryReasonId} className={styles.checkReason}>
          {PRIMARY_TAKEN_REASON}
        </p>
      ) : null}
    </>
  );
}
