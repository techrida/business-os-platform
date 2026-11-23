'use client';

import { type ReactNode, useActionState, useId, useRef, useState } from 'react';
import Link from 'next/link';

import type { ExpenseAccount } from '@bos/contracts';

import { PendingLine, useFocusOnProblem } from '@/components/p2/quotations/action-dialog';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Combobox, useExclusiveOpen } from '@/components/ui/combobox';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Field, Select } from '@/components/ui/field';
import { MoneyInput, QuantityInput } from '@/components/ui/number-input';
import { expenseAccountOptions } from '@/lib/company-account-options';

import type { ActionState } from '../../procurement/orders/_lib/state';
import { convertSubmissionAction, createBillAction } from '../actions';
import { BillHeaderInputs, type BillEntryHeader } from './bill-header-inputs';
import {
  ACTIVE_ACCOUNT_IDS_FIELD,
  EMPTY_ROW,
  MAX_LINES,
  NEW_BILL_HEADING,
  type LineRow,
} from '../_lib/forms';
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

export const COMPANY_ACCOUNTS_HREF = '/settings/company-accounts';

export function BillEntryForm({
  invoiceTitle = 'Vendor invoice',
  submissionId,
  idempotencyKey,
  orderLines,
  taxCodes,
  withholdingCodes = [],
  cancelHref,
  reloadHref,
  entry,
  expenseAccounts = [],
  canManageAccounts = false,
  initialRows,
  children,
}: {
  invoiceTitle?: string;
  /** Shown between the page heading (which holds Cancel and Create bill) and the form, outside the form. */
  children?: ReactNode;
  submissionId?: string;
  entry?: BillEntryHeader;
  idempotencyKey: string;
  /** Empty for a bill without a purchase order. */
  orderLines: readonly OrderLine[];
  taxCodes: readonly TaxOption[];
  withholdingCodes?: readonly TaxOption[];
  cancelHref: string;
  reloadHref: string;
  /**
   * The entity's expense accounts, retired ones included, so a value already on a row keeps its label. The
   * picker offers active accounts only.
   */
  expenseAccounts?: readonly ExpenseAccount[];
  /** Whether the viewer may open Settings > Bank and expense accounts (decides the link in the empty message). */
  canManageAccounts?: boolean;
  /** Rows to start from instead of empty ones, e.g. lines kept from an earlier attempt. */
  initialRows?: readonly LineRow[];
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    entry === undefined ? convertSubmissionAction : createBillAction,
    { key: idempotencyKey },
  );
  const [rows, setRows] = useState<LineRow[]>(() =>
    initialRows !== undefined && initialRows.length > 0
      ? initialRows.map((r) => ({ ...r }))
      : orderLines.length > 0
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

  const formId = useId();
  const picker = useExclusiveOpen();
  const noAccounts = expenseAccountOptions(expenseAccounts).length === 0;

  return (
    <>
      <PageHeader
        title={NEW_BILL_HEADING.title}
        description={NEW_BILL_HEADING.description}
        actions={
          <>
            <LinkButton href={cancelHref} variant="secondary">
              Cancel
            </LinkButton>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={pending || !invoiceReady}
              aria-busy={pending || undefined}
            >
              Create bill
            </Button>
          </>
        }
      />
      {children}
      <div ref={wrapRef}>
        <form id={formId} action={formAction} noValidate className={styles.form}>
          {submissionId !== undefined ? (
            <input type="hidden" name="submissionId" value={submissionId} />
          ) : null}
          <input type="hidden" name="idempotencyKey" value={state.key} />
          <input type="hidden" name="lineCount" value={rows.length} />
          {/* So a refused account marks only the lines whose account is not active on this page. */}
          <input
            type="hidden"
            name={ACTIVE_ACCOUNT_IDS_FIELD}
            value={expenseAccounts
              .filter((a) => a.status === 'active')
              .map((a) => a.id)
              .join(',')}
          />

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
            <Panel title={invoiceTitle}>
              <BillHeaderInputs
                entry={entry}
                errors={errors}
                pending={pending}
                onReady={setInvoiceReady}
              />
            </Panel>
          ) : null}

          <Panel title="Invoice lines">
            <p className={styles.note}>
              {fixed
                ? 'Enter what the invoice charges for each order line. A line you leave empty is not billed now. The platform works out the totals.'
                : 'Enter each line as the invoice shows it. The platform works out the VAT, the withholding and the totals.'}
            </p>
            {noAccounts ? (
              <Alert tone="warning" role="status" title="No expense accounts yet">
                Each line is booked to an expense account, and none is set up for this company.{' '}
                {canManageAccounts ? (
                  <>
                    Add one in <Link href={COMPANY_ACCOUNTS_HREF}>Bank and expense accounts</Link>,
                    then come back to this bill.
                  </>
                ) : (
                  'Ask someone in Finance to add one in Settings, under Bank and expense accounts.'
                )}
              </Alert>
            ) : null}

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
                        <QuantityInput
                          {...control}
                          name={fieldName(i, 'quantity')}
                          value={row.quantity}
                          onValueChange={(plain) => set(i, 'quantity', plain)}
                          currency="NPR"
                        />
                      )}
                    </Field>
                    <Field label="Unit price" error={errors[`${i}.unitPrice`]}>
                      {(control) => (
                        <MoneyInput
                          {...control}
                          name={fieldName(i, 'unitPrice')}
                          value={row.unitPrice}
                          onValueChange={(plain) => set(i, 'unitPrice', plain)}
                          currency="NPR"
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
                      label="Expense account"
                      hint="The account this line is booked to."
                      error={errors[`${i}.accountId`]}
                    >
                      {(control) => (
                        <>
                          <input
                            type="hidden"
                            name={fieldName(i, 'accountId')}
                            value={row.accountId}
                          />
                          <Combobox
                            labelledBy={control['aria-labelledby']}
                            describedBy={control['aria-describedby']}
                            invalid={control['aria-invalid'] === true}
                            options={expenseAccountOptions(expenseAccounts, {
                              currentId: row.accountId,
                            })}
                            value={row.accountId}
                            onChange={(id) => set(i, 'accountId', id)}
                            open={picker.isOpen(`account-${i}`)}
                            onOpenChange={(open) => picker.setOpen(`account-${i}`, open)}
                            placeholder="Search by code or name"
                            emptyText="No expense accounts to choose from."
                            noMatchText="No account matches. Search by code or name."
                          />
                        </>
                      )}
                    </Field>
                    <Field label="Withholding" optional error={errors[`${i}.tdsCodeId`]}>
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
          </Panel>
          <PendingLine pending={pending} words="Creating the bill" />
        </form>
      </div>
    </>
  );
}
