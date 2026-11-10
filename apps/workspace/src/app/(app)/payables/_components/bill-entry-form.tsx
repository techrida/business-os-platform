'use client';

import { useActionState, useRef, useState } from 'react';

import { PendingLine, useFocusOnProblem } from '@/components/p2/quotations/action-dialog';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

import type { ActionState } from '../../procurement/orders/_lib/state';
import { convertSubmissionAction, createBillAction } from '../actions';
import { BillHeaderInputs, type BillEntryHeader } from './bill-header-inputs';
import { EMPTY_ROW, MAX_LINES, type LineRow } from '../_lib/forms';
import styles from '../payables.module.css';

/**
 * The bill entry form, for a bill keyed from an inbox submission. The header (vendor, invoice
 * number, invoice date, order and file) comes from the submission and is shown by the page, not
 * typed here. The person keys the lines from the vendor's invoice; the server works out every net,
 * VAT, TDS and total, so none of them is asked for or shown before the save. On a purchase order
 * bill there is one row per order line, fixed, and a row left empty is not billed now. Inputs are
 * controlled so a refusal does not wipe what was typed (React 19 resets uncontrolled fields after
 * every action). The page makes one Idempotency-Key per render; the action hands back the key the
 * next submit must use (kept after a timeout, rotated after a 4xx).
 */

export interface OrderLine {
  poLineId: string;
  lineNo: number;
  description: string;
  uom: string;
  /** Display text from the server, e.g. `4`: what is still open on the order line. */
  open: string;
}

export interface TaxOption {
  id: string;
  label: string;
}

const fieldName = (i: number, field: keyof LineRow): string => `line:${i}:${field}`;

export function BillEntryForm({
  submissionId,
  idempotencyKey,
  orderLines,
  taxCodes,
  withholdingCodes = [],
  cancelHref,
  reloadHref,
  entry,
}: {
  submissionId?: string;
  entry?: BillEntryHeader;
  idempotencyKey: string;
  /** Empty for a bill without a purchase order. */
  orderLines: readonly OrderLine[];
  taxCodes: readonly TaxOption[];
  withholdingCodes?: readonly TaxOption[];
  cancelHref: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    entry === undefined ? convertSubmissionAction : createBillAction,
    { key: idempotencyKey },
  );
  const [rows, setRows] = useState<LineRow[]>(() =>
    orderLines.length > 0
      ? orderLines.map((l) => ({ ...EMPTY_ROW, poLineId: l.poLineId }))
      : [{ ...EMPTY_ROW }],
  );
  const [invoiceReady, setInvoiceReady] = useState(entry === undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);

  const errors = state.errors ?? {};
  const fixed = orderLines.length > 0;
  const set = (i: number, field: keyof LineRow, value: string): void =>
    setRows((all) => all.map((r, at) => (at === i ? { ...r, [field]: value } : r)));

  return (
    <div ref={wrapRef}>
      <form action={formAction} noValidate className={styles.form}>
        {submissionId !== undefined ? (
          <input type="hidden" name="submissionId" value={submissionId} />
        ) : null}
        <input type="hidden" name="idempotencyKey" value={state.key} />
        <input type="hidden" name="lineCount" value={rows.length} />

        {state.error ? (
          <Alert
            ref={summaryRef}
            tabIndex={-1}
            tone="error"
            role="alert"
            actions={state.reload ? <a href={reloadHref}>Reload this page</a> : null}
          >
            {state.error}
          </Alert>
        ) : null}
        {errors['lines'] ? (
          <p role="alert" className={styles.fieldError}>
            {errors['lines']}
          </p>
        ) : null}

        {entry !== undefined ? (
          <BillHeaderInputs
            entry={entry}
            errors={errors}
            pending={pending}
            onReady={setInvoiceReady}
          />
        ) : null}

        <p className={styles.note}>
          {fixed
            ? 'Enter what the invoice charges for each order line. A line you leave empty is not billed now. The platform works out the totals.'
            : 'Enter each line as the invoice shows it. The platform works out the VAT, the withholding and the totals.'}
        </p>

        {rows.map((row, i) => {
          const order = orderLines[i];
          const legend =
            order !== undefined
              ? `Line ${order.lineNo}: ${order.description}`
              : `Invoice line ${i + 1}`;
          return (
            <fieldset key={order?.poLineId ?? i} className={styles.lineGroup}>
              <legend>{legend}</legend>
              {order !== undefined ? (
                <>
                  <input type="hidden" name={fieldName(i, 'poLineId')} value={order.poLineId} />
                  <p className={styles.note}>
                    Still open on the order: {order.open} {order.uom}
                  </p>
                </>
              ) : null}
              <div className={styles.lineFields}>
                <Field label="Quantity" error={errors[`${i}.quantity`]}>
                  {(control) => (
                    <Input
                      name={fieldName(i, 'quantity')}
                      value={row.quantity}
                      onChange={(e) => set(i, 'quantity', e.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                      {...control}
                    />
                  )}
                </Field>
                <Field label="Unit price (NPR)" error={errors[`${i}.unitPrice`]}>
                  {(control) => (
                    <Input
                      name={fieldName(i, 'unitPrice')}
                      value={row.unitPrice}
                      onChange={(e) => set(i, 'unitPrice', e.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                      {...control}
                    />
                  )}
                </Field>
                <Field label="VAT" error={errors[`${i}.taxCodeId`]}>
                  {(control) => (
                    <Select
                      name={fieldName(i, 'taxCodeId')}
                      value={row.taxCodeId}
                      onChange={(e) => set(i, 'taxCodeId', e.target.value)}
                      {...control}
                    >
                      <option value="">Choose the VAT treatment</option>
                      {taxCodes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field
                  label="Account ID"
                  hint="The ledger account this line is booked to."
                  error={errors[`${i}.accountId`]}
                >
                  {(control) => (
                    <Input
                      name={fieldName(i, 'accountId')}
                      value={row.accountId}
                      onChange={(e) => set(i, 'accountId', e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      {...control}
                    />
                  )}
                </Field>
                <Field
                  label="Withholding (optional)"
                  hint="Leave empty when no tax is withheld."
                  error={errors[`${i}.tdsCodeId`]}
                >
                  {(control) => (
                    <Select
                      name={fieldName(i, 'tdsCodeId')}
                      value={row.tdsCodeId}
                      onChange={(e) => set(i, 'tdsCodeId', e.target.value)}
                      {...control}
                    >
                      <option value="">No withholding</option>
                      {withholdingCodes.map((code) => (
                        <option key={code.id} value={code.id}>
                          {code.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              {!fixed && rows.length > 1 ? (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    onClick={() => setRows((all) => all.filter((_, at) => at !== i))}
                  >
                    Remove line {i + 1}
                  </Button>
                </div>
              ) : null}
            </fieldset>
          );
        })}

        {!fixed && rows.length < MAX_LINES ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRows((all) => [...all, { ...EMPTY_ROW }])}
            >
              Add a line
            </Button>
          </div>
        ) : null}

        <div className={styles.formButtons}>
          <Button type="submit" variant="primary" disabled={pending || !invoiceReady}>
            Create bill
          </Button>
          <LinkButton href={cancelHref} variant="secondary">
            Cancel
          </LinkButton>
        </div>
        <PendingLine pending={pending} words="Creating the bill" />
      </form>
    </div>
  );
}
