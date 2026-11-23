'use client';

import Link from 'next/link';
import { type ChangeEvent, useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/portal/alert';
import { Field, Input } from '@/components/portal/field';
import quotation from '@/components/portal/quotation.module.css';
import { Button } from '@/components/ui/button';

import styles from '../../_upload/upload.module.css';
import { type BankFormState, requestBankChangeAction } from '../actions';

const EMPTY = {
  bankName: '',
  branch: '',
  accountName: '',
  accountNumber: '',
  confirmation: '',
  swift: '',
};

/**
 * Ask to change the bank account. A Client Component so the typed values survive a refusal. The
 * account number lives only in this form's fields: it is cleared after a success, is never put in
 * a URL, and is never shown back; the confirmation names the bank and the last four digits the
 * API answered with. The Idempotency-Key is in the form, so a retry after a timeout sends the very
 * same request.
 */
export function BankForm({
  idempotencyKey,
  initialState,
}: {
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  /** Overridable for tests: the state `useActionState` starts from. */
  initialState?: BankFormState | undefined;
}) {
  const [state, formAction, pending] = useActionState<BankFormState, FormData>(
    requestBankChangeAction,
    initialState ?? { key: idempotencyKey },
  );
  const fe = state.fieldErrors ?? {};

  // Controlled: React 19 resets uncontrolled fields after every action.
  const [values, setValues] = useState(EMPTY);
  const set = (name: keyof typeof EMPTY) => (e: ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [name]: e.target.value }));
  const errorRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);

  // Recorded: nothing typed stays in the form, least of all the number. Cleared while rendering
  // (React's way to reset state when a prop-like value changes), not in an effect.
  const [lastReceived, setLastReceived] = useState(state.received);
  if (state.received !== lastReceived) {
    setLastReceived(state.received);
    if (state.received) setValues(EMPTY);
  }

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  useEffect(() => {
    if (state.received) doneRef.current?.focus();
  }, [state.received]);

  const { received } = state;

  return (
    <form noValidate action={formAction} className={`${quotation.form} ${styles.formFrame}`}>
      <input type="hidden" name="idempotencyKey" value={state.key} />

      {received ? (
        <Alert ref={doneRef} tabIndex={-1} tone="success" role="status">
          {received.bankName !== null && received.last4 !== null
            ? `We received your request for the ${received.bankName} account ending ${received.last4}. `
            : 'We received your request. '}
          Our team will check it with you before we pay into it.
        </Alert>
      ) : null}

      {state.error ? (
        <Alert ref={errorRef} tabIndex={-1} tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}

      <div className={styles.grid}>
        <Field label="Bank name" error={fe.bankName}>
          {(control) => (
            <Input
              name="bankName"
              autoComplete="off"
              required
              maxLength={120}
              value={values.bankName}
              onChange={set('bankName')}
              {...control}
            />
          )}
        </Field>
        <Field label="Branch" optional error={fe.branch}>
          {(control) => (
            <Input
              name="branch"
              autoComplete="off"
              maxLength={120}
              value={values.branch}
              onChange={set('branch')}
              {...control}
            />
          )}
        </Field>
      </div>

      <Field label="Account name" hint="The name the account is held in." error={fe.accountName}>
        {(control) => (
          <Input
            name="accountName"
            autoComplete="off"
            required
            maxLength={160}
            value={values.accountName}
            onChange={set('accountName')}
            {...control}
          />
        )}
      </Field>

      <div className={styles.grid}>
        <Field label="Account number" error={fe.accountNumber}>
          {(control) => (
            <Input
              name="accountNumber"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              maxLength={40}
              placeholder="0012345678901"
              value={values.accountNumber}
              onChange={set('accountNumber')}
              {...control}
            />
          )}
        </Field>
        <Field label="Account number again" error={fe.confirmAccountNumber}>
          {(control) => (
            <Input
              name="confirmAccountNumber"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              maxLength={40}
              value={values.confirmation}
              onChange={set('confirmation')}
              {...control}
            />
          )}
        </Field>
      </div>

      <Field label="SWIFT code" optional hint="For an account outside Nepal." error={fe.swift}>
        {(control) => (
          <Input
            name="swift"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={11}
            placeholder="NABILNPKA"
            value={values.swift}
            onChange={set('swift')}
            {...control}
          />
        )}
      </Field>

      <div className={quotation.buttons}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Request change'}
        </Button>
        <Link href="/vendor">Cancel</Link>
      </div>
      <p className={quotation.liveStatus} role="status">
        {pending ? 'Sending your request' : ''}
      </p>
    </form>
  );
}
