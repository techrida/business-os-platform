'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';
import type { CurrencyChoice } from '@/lib/enabled-currencies';

import styles from '../_components/settings.module.css';
import { IDLE, type ActionState } from '../action-state';
import { FormStatus } from '../ui';
import {
  changeBankAccountStatusAction,
  changeExpenseAccountStatusAction,
  createBankAccountAction,
  createExpenseAccountAction,
  renameBankAccountAction,
  renameExpenseAccountAction,
} from './actions';
import { RETIRE_KEEPS_WORKING } from './copy';
import { useFormKey } from './use-form-key';
import local from './company-accounts.module.css';

export type AccountKind = 'bank' | 'expense';

const NOUN: Record<AccountKind, string> = { bank: 'bank account', expense: 'expense account' };

/** Where a retired row stops being offered, for the confirmation sentence. */
const OFFERED_ON: Record<AccountKind, string> = {
  bank: 'new payment requests',
  expense: 'new bills',
};

// ---------------------------------------------------------------------------------------------
// Add forms
// ---------------------------------------------------------------------------------------------

export function AddBankAccountForm({
  currencies,
  idempotencyKey,
}: {
  currencies: readonly CurrencyChoice[];
  /** One key per render of the page; kept until a save succeeds (see `useFormKey`). */
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(createBankAccountAction, IDLE);
  const key = useFormKey(idempotencyKey, state);
  const kept = state.status === 'error' ? (state.fields ?? {}) : {};
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className={styles.form} aria-label="Add a bank account">
      <input type="hidden" name="idempotencyKey" value={key} />
      <div className={styles.formRow}>
        <Field
          label="Name"
          hint="What you call it, for example Operating account."
          error={errors.name}
        >
          {(control) => (
            <Input
              name="name"
              autoComplete="off"
              required
              maxLength={120}
              defaultValue={kept.name ?? ''}
              {...control}
            />
          )}
        </Field>
        <Field label="Bank name" error={errors.bankName}>
          {(control) => (
            <Input
              name="bankName"
              autoComplete="off"
              required
              maxLength={120}
              defaultValue={kept.bankName ?? ''}
              {...control}
            />
          )}
        </Field>
        <Field
          label="Last four characters of the account number"
          hint="Only these four are stored."
          error={errors.last4}
        >
          {(control) => (
            <Input
              name="last4"
              autoComplete="off"
              required
              minLength={4}
              pattern="[A-Za-z0-9]{4}"
              title="Four letters or digits, for example 4821"
              className={local.short}
              defaultValue={kept.last4 ?? ''}
              {...control}
            />
          )}
        </Field>
        <Field label="Currency" error={errors.currency}>
          {(control) => (
            <Select
              name="currency"
              defaultValue={kept.currency ?? currencies[0]?.value ?? 'NPR'}
              {...control}
            >
              {currencies.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.value === c.label ? c.value : `${c.value} · ${c.label}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          Add bank account
        </Button>
        <div className={styles.status}>
          <FormStatus state={state} pending={pending} />
        </div>
      </div>
    </form>
  );
}

export function AddExpenseAccountForm({ idempotencyKey }: { idempotencyKey: string }) {
  const [state, formAction, pending] = useActionState(createExpenseAccountAction, IDLE);
  const key = useFormKey(idempotencyKey, state);
  const kept = state.status === 'error' ? (state.fields ?? {}) : {};
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className={styles.form} aria-label="Add an expense account">
      <input type="hidden" name="idempotencyKey" value={key} />
      <div className={styles.formRow}>
        <Field label="Code" hint="Fixed once added, for example 5100." error={errors.code}>
          {(control) => (
            <Input
              name="code"
              autoComplete="off"
              required
              maxLength={32}
              className={local.short}
              defaultValue={kept.code ?? ''}
              {...control}
            />
          )}
        </Field>
        <Field label="Name" hint="For example Office supplies." error={errors.name}>
          {(control) => (
            <Input
              name="name"
              autoComplete="off"
              required
              maxLength={120}
              defaultValue={kept.name ?? ''}
              {...control}
            />
          )}
        </Field>
      </div>
      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          Add expense account
        </Button>
        <div className={styles.status}>
          <FormStatus state={state} pending={pending} />
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Inline rename
// ---------------------------------------------------------------------------------------------

/**
 * The row's name with a Rename button. Renaming swaps in a one-field form in the same cell; Escape or
 * Cancel puts the name back and returns focus to the Rename button.
 */
export function RenameableName({
  kind,
  id,
  name,
  prefix,
}: {
  kind: AccountKind;
  id: string;
  name: string;
  /** Shown before the name in labels, for example the expense code. */
  prefix?: string;
}) {
  const [editing, setEditing] = useState(false);
  // One key per time the form is opened (made in the click, never in the server render): a double click on Save
  // renames once. The form closes on success, so the next opening gets its own key.
  const [renameKey, setRenameKey] = useState('');
  // A saved name closes the form, which unmounts its FormStatus, so the success toast is raised here.
  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const rename = kind === 'bank' ? renameBankAccountAction : renameExpenseAccountAction;
      const next = await rename(previous, formData);
      if (next.status === 'ok') {
        toast.success(next.message);
        close();
      }
      return next;
    },
    IDLE,
  );
  const renameButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const label = prefix ? `${prefix} ${name}` : name;

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  function close() {
    setEditing(false);
    requestAnimationFrame(() => renameButton.current?.focus());
  }

  if (!editing) {
    return (
      <span className={local.nameCell}>
        <span>{name}</span>
        <Button
          ref={renameButton}
          type="button"
          variant="tertiary"
          size="small"
          aria-label={`Rename ${label}`}
          onClick={() => {
            setRenameKey(crypto.randomUUID());
            setEditing(true);
          }}
        >
          Rename
        </Button>
      </span>
    );
  }

  const kept = state.status === 'error' ? (state.fields?.name ?? name) : name;
  return (
    <form
      action={formAction}
      className={local.renameForm}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="idempotencyKey" value={renameKey} />
      <Field label={`New name for ${label}`} error={state.fieldErrors?.name}>
        {(control) => (
          <Input
            ref={input}
            name="name"
            autoComplete="off"
            required
            maxLength={120}
            defaultValue={kept}
            {...control}
          />
        )}
      </Field>
      <div className={local.renameActions}>
        <Button type="submit" size="small" disabled={pending}>
          Save name
        </Button>
        <Button type="button" size="small" variant="secondary" disabled={pending} onClick={close}>
          Cancel
        </Button>
      </div>
      <FormStatus state={state} pending={pending} successToast={false} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Retire and reactivate
// ---------------------------------------------------------------------------------------------

const changeStatus = (kind: AccountKind) =>
  kind === 'bank' ? changeBankAccountStatusAction : changeExpenseAccountStatusAction;

/**
 * The Idempotency-Key for one status button: made on the first press, kept across presses and failed tries so a
 * double click or a retry changes the account once, and renewed after a change succeeds.
 */
function useStatusKey() {
  const held = useRef<string | null>(null);
  return {
    current: () => (held.current ??= crypto.randomUUID()),
    renew: () => {
      held.current = null;
    },
  };
}

/** Retire asks first and says what keeps working; nothing is ever deleted. */
export function RetireButton({
  kind,
  id,
  label,
}: {
  kind: AccountKind;
  id: string;
  label: string;
}) {
  const key = useStatusKey();
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="secondary" size="small" aria-label={`Retire ${label}`}>
          Retire
        </Button>
      }
      title={`Retire ${label}?`}
      description={`It is no longer offered on ${OFFERED_ON[kind]}. ${RETIRE_KEEPS_WORKING}`}
      confirmLabel={`Retire ${NOUN[kind]}`}
      onConfirm={async () => {
        const result = await changeStatus(kind)(id, 'retire', key.current());
        if (result.status === 'error') {
          toast.error(result.message);
          return false;
        }
        key.renew();
        toast.success(result.message);
        return true;
      }}
    />
  );
}

export function ReactivateButton({
  kind,
  id,
  label,
}: {
  kind: AccountKind;
  id: string;
  label: string;
}) {
  const [pending, startTransition] = useTransition();
  const key = useStatusKey();
  return (
    <Button
      type="button"
      variant="secondary"
      size="small"
      aria-label={`Reactivate ${label}`}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() =>
        startTransition(async () => {
          const result = await changeStatus(kind)(id, 'reactivate', key.current());
          if (result.status === 'error') toast.error(result.message);
          else {
            key.renew();
            toast.success(result.message);
          }
        })
      }
    >
      Reactivate
    </Button>
  );
}
