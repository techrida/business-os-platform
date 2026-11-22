'use client';

import type { Currency, TaxCode } from '@bos/contracts';
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import {
  createCreditNoteAction,
  createDebitNoteAction,
} from '@/app/(app)/invoices/_components/notes/actions';
import type { InvoiceFormState } from '@/app/(app)/invoices/new/form-state';
import { LinesEditor, useLines } from '@/app/(app)/invoices/new/lines-editor';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { QuantityInput } from '@/components/ui/number-input';
import { toast } from '@/components/ui/toast';
import { useFocusOnProblem } from '@/components/p2/quotations/action-dialog';

import styles from './notes.module.css';

interface NoteProps {
  originalInvoiceId: string;
  /** What the dialog calls the invoice: its number. */
  name: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * What both note forms share: hidden ids, the page's key, the refusal summary (with a plain reload
 * link when the invoice moved), the reason, the buttons and the line that tells a screen reader the
 * request is on its way. On success the action redirects to the new draft note, so there is no
 * "done" state here. The reason is controlled: React 19 resets uncontrolled fields after every
 * action, which would wipe what the person typed when the API refuses.
 */
function NoteForm({
  action,
  originalInvoiceId,
  idempotencyKey,
  reloadHref,
  lines,
  triggerLabel,
  title,
  description,
  confirmLabel,
  pendingWords,
  reasonHint,
  disabled,
  children,
}: Omit<NoteProps, 'name'> & {
  action: (prev: InvoiceFormState, form: FormData) => Promise<InvoiceFormState>;
  /** The posted `lines` field: what the person entered, as the action parses it. */
  lines: unknown;
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  pendingWords: string;
  reasonHint: string;
  disabled?: boolean;
  /** The fields above the reason, given the state so a line can show its own error. */
  children: (state: InvoiceFormState) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
  });
  const [reason, setReason] = useState('');
  const formId = useId();
  const wrapRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  const summary = state.error ?? state.errors['form'];
  useEffect(() => {
    if (state.error || Object.keys(state.errors).length) toast.error('Check the note fields');
  }, [state]);

  return (
    <Dialog
      trigger={<Button variant="secondary">{triggerLabel}</Button>}
      title={title}
      description={description}
      locked={pending}
      closeOnOutsideClick={false}
      size="large"
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending || disabled === true}>
            {pending ? pendingWords : confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} ref={wrapRef} action={formAction} noValidate className={styles.form}>
        <input type="hidden" name="originalInvoiceId" value={originalInvoiceId} />
        <input type="hidden" name="idempotencyKey" value={state.key} />
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />

        {summary ? (
          <Alert
            ref={summaryRef}
            tabIndex={-1}
            tone="error"
            role="alert"
            actions={state.reload ? <a href={reloadHref}>Reload this invoice</a> : null}
          >
            {summary}
          </Alert>
        ) : null}

        {children(state)}
        {state.errors['lines'] ? (
          <p role="alert" className={styles.error}>
            {state.errors['lines']}
          </p>
        ) : null}

        <Field label="Reason" hint={reasonHint} error={state.errors['reason']}>
          {(control) => (
            <Textarea
              name="reason"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              {...control}
            />
          )}
        </Field>

        <p className="sr-only" role="status">
          {pending ? pendingWords : ''}
        </p>
      </form>
    </Dialog>
  );
}

export interface CreditLineSource {
  lineNo: number;
  description: string;
  uom: string;
  quantity: string;
}

/**
 * Credit note: the person says how much of each original line to credit and why. There is no price
 * and no total here: the server prices the note from the original lines and refuses a credit above
 * what the invoice, less earlier credit notes, can still take.
 */
export function CreditNoteDialog({
  name,
  lines,
  ...rest
}: NoteProps & { lines: readonly CreditLineSource[] }) {
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const posted = lines.map((l) => ({ lineNo: l.lineNo, quantity: quantities[l.lineNo] ?? '' }));
  return (
    <NoteForm
      {...rest}
      triggerLabel="Credit note"
      title={`Credit note for ${name}`}
      description="Choose the quantities to credit. Finance issues the note after review."
      action={createCreditNoteAction}
      lines={posted}
      confirmLabel="Create credit note"
      pendingWords="Creating"
      reasonHint="Kept on the note and shown to the approvers."
    >
      {(state) => (
        <CreditLines
          lines={lines}
          quantities={quantities}
          errors={state.errors}
          onChange={(lineNo, value) => setQuantities((q) => ({ ...q, [lineNo]: value }))}
        />
      )}
    </NoteForm>
  );
}

function CreditLines({
  lines,
  quantities,
  errors,
  onChange,
}: {
  lines: readonly CreditLineSource[];
  quantities: Record<number, string>;
  errors: Record<string, string>;
  onChange: (lineNo: number, value: string) => void;
}) {
  return (
    <ol className={styles.credit}>
      {lines.map((line, index) => (
        <li key={line.lineNo} className={styles.creditLine}>
          <div className={styles.creditText}>
            <span className={styles.creditName}>
              {line.lineNo}. {line.description}
            </span>
            <span
              className={styles.creditHeld}
            >{`On the invoice: ${line.quantity} ${line.uom}`}</span>
          </div>
          <CreditQuantity
            line={line}
            error={errors[`lines.${index}.quantity`]}
            value={quantities[line.lineNo] ?? ''}
            onChange={(v) => onChange(line.lineNo, v)}
          />
        </li>
      ))}
    </ol>
  );
}

function CreditQuantity({
  line,
  error,
  value,
  onChange,
}: {
  line: CreditLineSource;
  error: string | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      label={
        <>
          Quantity to credit<span className="sr-only"> (line {line.lineNo})</span>
        </>
      }
      error={error}
      className={styles.creditField ?? ''}
    >
      {(control) => (
        // Blank or 0 leaves the line out of the note, so zero is a valid entry here.
        <QuantityInput
          {...control}
          min="0"
          placeholder="0"
          className={styles.numeric ?? ''}
          uom={line.uom}
          value={value}
          onValueChange={onChange}
        />
      )}
    </Field>
  );
}

/**
 * Debit note: new lines for what was under-charged, and why. Same line editor as a manual invoice;
 * the server prices the lines.
 */
export function DebitNoteDialog({
  name,
  currency,
  taxCodes,
  ...rest
}: NoteProps & { currency: Currency; taxCodes: readonly TaxCode[] | null }) {
  const { lines, setLine, add, remove } = useLines(1);
  return (
    <NoteForm
      {...rest}
      triggerLabel="Debit note"
      title={`Debit note for ${name}`}
      description="Add the items that were undercharged. Finance issues the note after review."
      action={createDebitNoteAction}
      lines={lines}
      confirmLabel="Create debit note"
      pendingWords="Creating"
      reasonHint="Kept on the note and shown to the approvers."
      disabled={taxCodes === null || taxCodes.length === 0}
    >
      {(state) => (
        <LinesEditor
          lines={lines}
          currency={currency}
          taxCodes={taxCodes}
          errors={state.errors}
          onChange={setLine}
          onAdd={add}
          onRemove={remove}
        />
      )}
    </NoteForm>
  );
}
