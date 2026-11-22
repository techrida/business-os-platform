'use client';

import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/number-input';
import { toast } from '@/components/ui/toast';

import {
  CREDIT_LIMIT_NOTE,
  TERMS_START,
  type CreditLimitMode,
  type TermsEditState,
} from './terms-form';
import styles from './commercial-terms.module.css';

type TermsAction = (prev: TermsEditState, form: FormData) => Promise<TermsEditState>;

export interface PersonOption {
  userId: string;
  displayName: string;
}

export interface TermOption {
  id: string;
  label: string;
}

/**
 * One field's edit in a dialog: the trigger, the form, the refusal summary and the fixed footer. A save closes the
 * dialog with a toast; a refusal stays in it. `children` gets the state's field error and the save count, so a
 * draft belongs to one save and resets after it. Hidden fields come from the page as rendered, so after a stale
 * save reloads the page they carry the latest version.
 */
function TermsDialog({
  name,
  title,
  action,
  hidden,
  children,
}: {
  /** What the trigger changes, for its accessible name ("Change credit limit"). */
  name: string;
  title: string;
  action: TermsAction;
  hidden: Record<string, string>;
  children: (field: { error: string | undefined; savedCount: number }) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState<TermsEditState, FormData>(
    action,
    TERMS_START,
  );
  const formId = useId();
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.saved) toast.success(state.saved);
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <Dialog
      trigger={
        <Button variant="tertiary" size="small">
          Change<span className="sr-only"> {name}</span>
        </Button>
      }
      title={title}
      open={openedAt === state.savedCount}
      onOpenChange={(open) => setOpenedAt(open ? state.savedCount : null)}
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending}>
            {pending ? 'Saving' : 'Save'}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} action={formAction} noValidate className={styles.form}>
        {Object.entries(hidden).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        {state.error ? (
          <Alert
            ref={summaryRef}
            tabIndex={-1}
            tone={state.stale || state.entityChanged ? 'warning' : 'error'}
            role="alert"
            title={
              state.entityChanged
                ? 'Legal entity changed'
                : state.stale
                  ? 'Changed by someone else'
                  : 'Not saved'
            }
          >
            {state.error}
          </Alert>
        ) : null}
        {children({ error: state.errors.value, savedCount: state.savedCount })}
      </form>
    </Dialog>
  );
}

/** A draft value that belongs to one save: after a save it falls back to the saved value again. */
function useDraft(initial: string, savedCount: number) {
  const [draft, setDraft] = useState({ savedCount, value: initial });
  const value = draft.savedCount === savedCount ? draft.value : initial;
  return [value, (next: string) => setDraft({ savedCount, value: next })] as const;
}

function OwnerSelect({
  people,
  current,
  error,
  savedCount,
}: {
  people: readonly PersonOption[];
  current: { userId: string | null; name: string | null };
  error: string | undefined;
  savedCount: number;
}) {
  const [value, setValue] = useDraft(current.userId ?? '', savedCount);
  // The stored owner stays selectable when the list no longer holds them (disabled or invited), so the field
  // never silently shows someone else.
  const options = people.map((p) => ({ value: p.userId, label: p.displayName }));
  if (current.userId !== null && !options.some((o) => o.value === current.userId)) {
    options.unshift({
      value: current.userId,
      label: `${current.name ?? 'Current owner'} (cannot be chosen again)`,
    });
  }
  return (
    <Field
      label="Account owner"
      hint="Active staff of your company. The owner answers for this customer and invites its first portal admin."
      error={error}
    >
      {(c) => (
        <Select
          name="ownerUserId"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          {...c}
        >
          <option value="">Choose a person</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** Change the customer's account owner (`customers.owner.write`). */
export function OwnerForm({
  action,
  customerId,
  version,
  current,
  people,
}: {
  action: TermsAction;
  customerId: string;
  /** The customer's row version, as the page rendered it. */
  version: number;
  current: { userId: string | null; name: string | null };
  people: readonly PersonOption[];
}) {
  return (
    <TermsDialog
      name="account owner"
      title="Change account owner"
      action={action}
      hidden={{
        customerId,
        expectedVersion: String(version),
        currentOwnerUserId: current.userId ?? '',
      }}
    >
      {({ error, savedCount }) => (
        <OwnerSelect people={people} current={current} error={error} savedCount={savedCount} />
      )}
    </TermsDialog>
  );
}

function TermSelect({
  terms,
  current,
  error,
  savedCount,
}: {
  terms: readonly TermOption[];
  current: string | null;
  error: string | undefined;
  savedCount: number;
}) {
  const [value, setValue] = useDraft(current ?? '', savedCount);
  const options = terms.map((t) => ({ value: t.id, label: t.label }));
  if (current !== null && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: 'Current terms (no longer offered)' });
  }
  return (
    <Field label="Payment terms" hint="Only active payment terms are listed." error={error}>
      {(c) => (
        <Select
          name="paymentTermId"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          {...c}
        >
          <option value="">No payment terms</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** Set or clear the payment terms with the acting entity (customer.write). */
export function PaymentTermForm({
  action,
  customerId,
  organizationId,
  version,
  current,
  terms,
  entityName,
}: {
  action: TermsAction;
  customerId: string;
  /** The acting entity the page was rendered for: the API refuses the save once the person acts for another. */
  organizationId: string;
  /** The terms row's version, or null before the first save. */
  version: number | null;
  current: string | null;
  terms: readonly TermOption[];
  entityName: string;
}) {
  return (
    <TermsDialog
      name="payment terms"
      title={`Payment terms with ${entityName}`}
      action={action}
      hidden={{
        customerId,
        organizationId,
        expectedVersion: version === null ? '' : String(version),
        currentPaymentTermId: current ?? '',
      }}
    >
      {({ error, savedCount }) => (
        <TermSelect terms={terms} current={current} error={error} savedCount={savedCount} />
      )}
    </TermsDialog>
  );
}

function LimitFields({
  current,
  error,
  savedCount,
}: {
  current: string | null;
  error: string | undefined;
  savedCount: number;
}) {
  const [mode, setMode] = useDraft('limit', savedCount);
  const [amount, setAmount] = useDraft(current ?? '', savedCount);
  const noLimit = (mode as CreditLimitMode) === 'none';
  return (
    <>
      <fieldset className={styles.choices}>
        <legend className={styles.legend}>Limit</legend>
        <label className={styles.choice}>
          <input
            type="radio"
            name="limitMode"
            value="limit"
            checked={!noLimit}
            onChange={() => setMode('limit')}
          />
          Set a limit
        </label>
        <label className={styles.choice}>
          <input
            type="radio"
            name="limitMode"
            value="none"
            checked={noLimit}
            onChange={() => setMode('none')}
          />
          No limit (orders are never held for credit)
        </label>
      </fieldset>
      {noLimit ? null : (
        <Field
          label="Credit limit (NPR)"
          hint="Up to two decimals, for example 1,00,000.00. 0.00 is a real limit: it holds any order unless the customer has enough credit on account to cover it."
          error={error}
        >
          {(c) => (
            <MoneyInput
              name="creditLimit"
              currency="NPR"
              showWords
              placeholder="0.00"
              value={amount}
              onValueChange={setAmount}
              {...c}
            />
          )}
        </Field>
      )}
      {noLimit && error ? (
        <p role="alert" className={styles.fieldError}>
          {error}
        </p>
      ) : null}
      <p className={styles.note}>{CREDIT_LIMIT_NOTE}</p>
    </>
  );
}

/** Set or remove the credit limit with the acting entity (`customers.credit_limit.write`). NPR only. */
export function CreditLimitForm({
  action,
  customerId,
  organizationId,
  version,
  current,
  entityName,
}: {
  action: TermsAction;
  customerId: string;
  /** The acting entity the page was rendered for: the API refuses the save once the person acts for another. */
  organizationId: string;
  /** The terms row's version, or null before the first save. */
  version: number | null;
  /** NPR with two decimals, or null for no limit. */
  current: string | null;
  entityName: string;
}) {
  return (
    <TermsDialog
      name="credit limit"
      title={`Credit limit with ${entityName}`}
      action={action}
      hidden={{
        customerId,
        organizationId,
        expectedVersion: version === null ? '' : String(version),
        currentCreditLimit: current ?? '',
      }}
    >
      {({ error, savedCount }) => (
        <LimitFields current={current} error={error} savedCount={savedCount} />
      )}
    </TermsDialog>
  );
}
