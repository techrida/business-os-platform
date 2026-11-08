'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

import type { ContactFormState } from './form-state';
import { EMPTY_CONTACT_VALUES, type ContactField, type ContactValues } from './forms';
import styles from './customer-form.module.css';

/**
 * Add a contact to a customer. The outer component owns the action state; the fields live in a
 * child keyed by `savedCount`, so a saved contact clears the form while a refusal keeps what was
 * typed (React 19 resets uncontrolled fields after every action, so the inputs are controlled).
 */
export function ContactForm({
  action,
  customerId,
  idempotencyKey,
}: {
  action: (prev: ContactFormState, form: FormData) => Promise<ContactFormState>;
  customerId: string;
  /** A UUID the server made for this render. */
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState<ContactFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
    savedCount: 0,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.contactForm}>
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />

      {state.error ? (
        <Alert ref={summaryRef} tabIndex={-1} tone="error" role="alert" title="Contact not saved">
          {state.error}
        </Alert>
      ) : null}
      {state.saved ? (
        <Alert tone="success" role="status">
          {state.saved}
        </Alert>
      ) : null}

      <ContactFields key={state.savedCount} errors={state.errors} />

      <div className={styles.actions}>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving' : 'Add contact'}
        </Button>
      </div>
    </form>
  );
}

function ContactFields({ errors }: { errors: ContactFormState['errors'] }) {
  const [values, setValues] = useState<ContactValues>(EMPTY_CONTACT_VALUES);
  const set =
    (field: ContactField) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));

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
        <Field label="Email" hint="Optional." error={errors.email}>
          {(control) => (
            <Input
              type="email"
              name="email"
              value={values.email}
              onChange={set('email')}
              maxLength={254}
              autoComplete="off"
              {...control}
            />
          )}
        </Field>
        <Field
          label="Phone"
          hint="Optional. Start with + and the country code, for example +9779812345678."
          error={errors.phone}
        >
          {(control) => (
            <Input
              type="tel"
              name="phone"
              value={values.phone}
              onChange={set('phone')}
              maxLength={30}
              autoComplete="off"
              className={styles.numeric}
              {...control}
            />
          )}
        </Field>
      </div>
      <label className={styles.check}>
        <input
          type="checkbox"
          name="isPrimary"
          checked={values.isPrimary}
          onChange={(e) => setValues((v) => ({ ...v, isPrimary: e.target.checked }))}
        />
        Make this the main contact
      </label>
    </>
  );
}
