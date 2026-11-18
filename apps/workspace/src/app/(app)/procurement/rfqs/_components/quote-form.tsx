'use client';

import { CURRENCIES, type TaxCode } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page';
import { FactList, Panel } from '@/components/ui/panel';

import { ProcurementFormActions } from '../../form-actions';
import styles from '../../requests/requests.module.css';
import {
  emptyQuoteValues,
  type QuoteLineValues,
  type QuoteMode,
  type QuoteValues,
} from '../_lib/forms';
import type { RfqFormState } from '../_lib/state';
import type { VendorOption } from './rfq-form';

const WIDE = styles.wide ?? '';

export interface PrLineOption {
  id: string;
  lineNo: number;
  description: string;
  uom: string;
  quantity: string;
}

/** The vendor upload being converted: its vendor and file come from the submission, not the form. */
export interface SubmissionInfo {
  id: string;
  vendorName: string;
  vendorRef: string | null;
  sentAt: string;
}

/**
 * Staff enter a quotation from a vendor's document (`record`), or convert a clean vendor upload
 * (`convert`). One component for both, like the purchase request form: the lines are the purchase
 * request's lines, each one ticked to quote or left out. Inputs are controlled so a refusal does
 * not wipe what was typed. There is no running total on purpose: quantities and prices go to the
 * platform as typed, and the platform's totals appear on the RFQ page.
 */
export function QuoteForm({
  action,
  idempotencyKey,
  rfqId,
  rfqNumber,
  mode,
  vendors,
  submission,
  prLines,
  taxCodes,
  taxCodeProblem,
  cancelHref,
  reloadHref,
}: {
  action: (prev: RfqFormState, form: FormData) => Promise<RfqFormState>;
  /** A UUID the server made for this render. */
  idempotencyKey: string;
  rfqId: string;
  rfqNumber?: string;
  mode: QuoteMode;
  /** The invited vendors, for `record`. */
  vendors: VendorOption[];
  submission?: SubmissionInfo;
  prLines: PrLineOption[];
  /** Null when the list could not be read. Entry waits for an available tax-code list. */
  taxCodes: TaxCode[] | null;
  taxCodeProblem?: { status: number; message: string };
  cancelHref: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<RfqFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
  });
  const [values, setValues] = useState<QuoteValues>(() => ({
    ...emptyQuoteValues(mode, prLines),
    submissionId: submission?.id ?? '',
    vendorRef: submission?.vendorRef ?? '',
  }));
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  type HeaderKey = Exclude<keyof QuoteValues, 'lines' | 'mode'>;
  const set =
    (field: HeaderKey) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));
  const setLine = (i: number, patch: Partial<QuoteLineValues>): void =>
    setValues((v) => ({
      ...v,
      lines: v.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)),
    }));

  const err = state.errors;
  const hasTaxCodes = taxCodes !== null && taxCodes.length > 0;
  const taxCodesForbidden = taxCodeProblem?.status === 403;
  const unavailableTax = (id: string) =>
    id !== '' && !(taxCodes ?? []).some((tax) => tax.id === id);
  const hasUnavailableTax = values.lines.some(
    (line) => line.include && unavailableTax(line.taxCodeId),
  );

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <PageHeader
        title={mode === 'convert' ? 'Convert a vendor submission' : 'Enter a quotation'}
        description={
          rfqNumber
            ? `For ${rfqNumber}. A quotation is recorded for one invited vendor, once.`
            : undefined
        }
        actions={
          <ProcurementFormActions
            cancelHref={cancelHref}
            submitLabel={
              pending ? 'Saving' : mode === 'convert' ? 'Convert to quotation' : 'Record quotation'
            }
            disabled={pending || !hasTaxCodes || hasUnavailableTax}
          />
        }
      />
      {pending ? (
        <span className="sr-only" role="status">
          Saving the quotation
        </span>
      ) : null}
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <input type="hidden" name="rfqId" value={rfqId} />
      <input type="hidden" name="mode" value={mode} />
      {mode === 'convert' ? (
        <input type="hidden" name="submissionId" value={values.submissionId} />
      ) : null}

      {!hasTaxCodes ? (
        <Alert
          tone={taxCodes === null && !taxCodesForbidden ? 'error' : 'info'}
          role={taxCodes === null ? 'alert' : 'status'}
          title={
            taxCodesForbidden
              ? 'Your roles do not include tax codes'
              : taxCodes === null
                ? 'Tax codes did not load'
                : 'No tax codes are available'
          }
          actions={taxCodesForbidden ? null : <a href={reloadHref}>Try loading tax codes again</a>}
        >
          {taxCodesForbidden
            ? taxCodeProblem.message
            : taxCodes === null
              ? 'Load the tax codes before recording this quotation.'
              : 'Ask an administrator to configure tax codes before recording this quotation.'}
        </Alert>
      ) : null}

      {state.error ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title={state.reload ? 'This page is out of date' : 'The quotation was not recorded'}
          actions={state.reload ? <a href={reloadHref}>Reload this page</a> : null}
        >
          {state.error}
        </Alert>
      ) : null}

      <Panel
        title="Quotation details"
        description={
          mode === 'convert'
            ? 'The vendor and the uploaded file come from their submission. Type in what their document says.'
            : 'Type in what the vendor’s document says. The platform works out the totals.'
        }
      >
        {mode === 'convert' && submission !== undefined ? (
          <FactList
            facts={[
              { key: 'vendor', label: 'Vendor', value: submission.vendorName },
              { key: 'sent', label: 'Sent', value: submission.sentAt },
            ]}
          />
        ) : null}
        <div className={styles.grid}>
          {mode === 'record' ? (
            <>
              <Field label="Vendor" hint="Only invited vendors." error={err.vendorId}>
                {(control) => (
                  <Select
                    name="vendorId"
                    value={values.vendorId}
                    onChange={set('vendorId')}
                    required
                    {...control}
                  >
                    <option value="">Choose a vendor</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label="Quotation document"
                hint="The id of the vendor’s file, already uploaded to documents."
                error={err.documentId}
              >
                {(control) => (
                  <Input
                    name="documentId"
                    value={values.documentId}
                    onChange={set('documentId')}
                    autoComplete="off"
                    spellCheck={false}
                    className={styles.numeric}
                    required
                    {...control}
                  />
                )}
              </Field>
            </>
          ) : null}
          <Field label="Vendor’s reference" hint="Optional." error={err.vendorRef}>
            {(control) => (
              <Input
                name="vendorRef"
                value={values.vendorRef}
                onChange={set('vendorRef')}
                maxLength={100}
                {...control}
              />
            )}
          </Field>
          <Field label="Currency" error={err.currency}>
            {(control) => (
              <Select
                name="currency"
                value={values.currency}
                onChange={set('currency')}
                {...control}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Valid until" hint="Optional." error={err.validUntil}>
            {(control) => (
              <Input
                type="date"
                name="validUntil"
                value={values.validUntil}
                onChange={set('validUntil')}
                {...control}
              />
            )}
          </Field>
          <Field label="Delivery time (days)" hint="Optional." error={err.deliveryDays}>
            {(control) => (
              <Input
                name="deliveryDays"
                value={values.deliveryDays}
                onChange={set('deliveryDays')}
                inputMode="numeric"
                autoComplete="off"
                className={styles.numeric}
                {...control}
              />
            )}
          </Field>
          <Field label="Warranty" hint="Optional." error={err.warranty} className={WIDE}>
            {(control) => (
              <Input
                name="warranty"
                value={values.warranty}
                onChange={set('warranty')}
                maxLength={500}
                {...control}
              />
            )}
          </Field>
          <Field label="Terms" hint="Optional." error={err.terms} className={WIDE}>
            {(control) => (
              <Textarea
                name="terms"
                value={values.terms}
                onChange={set('terms')}
                rows={2}
                maxLength={2000}
                {...control}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title="Line items"
        description="One row for each line of the purchase request. Untick a line the vendor did not quote."
      >
        <div className={styles.lines}>
          {prLines.map((pl, i) => {
            const line = values.lines[i];
            if (line === undefined) return null;
            return (
              <fieldset key={pl.id} className={styles.line}>
                <legend>Line {pl.lineNo}</legend>
                <input type="hidden" name={`lines.${i}.prLineId`} value={pl.id} />
                <div className={styles.lineGrid}>
                  <div className={WIDE}>
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        name={`lines.${i}.include`}
                        checked={line.include}
                        onChange={(e) => setLine(i, { include: e.target.checked })}
                      />
                      <span className={styles.long}>
                        Quote this line: {pl.description} ({pl.quantity} {pl.uom} requested)
                      </span>
                    </label>
                  </div>
                  <Field label="Quantity" error={err[`lines.${i}.quantity`]}>
                    {(control) => (
                      <Input
                        name={`lines.${i}.quantity`}
                        value={line.quantity}
                        onChange={(e) => setLine(i, { quantity: e.target.value })}
                        inputMode="decimal"
                        autoComplete="off"
                        className={styles.numeric}
                        disabled={!line.include}
                        {...control}
                      />
                    )}
                  </Field>
                  <Field
                    label={`Unit price (${values.currency})`}
                    error={err[`lines.${i}.unitPrice`]}
                  >
                    {(control) => (
                      <Input
                        name={`lines.${i}.unitPrice`}
                        value={line.unitPrice}
                        onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                        inputMode="decimal"
                        autoComplete="off"
                        className={styles.numeric}
                        disabled={!line.include}
                        {...control}
                      />
                    )}
                  </Field>
                  <Field
                    label="Tax code"
                    hint={
                      unavailableTax(line.taxCodeId)
                        ? 'Choose an available tax code for this line.'
                        : undefined
                    }
                    error={err[`lines.${i}.taxCodeId`]}
                  >
                    {(control) => (
                      <Select
                        name={`lines.${i}.taxCodeId`}
                        value={line.taxCodeId}
                        onChange={(e) => setLine(i, { taxCodeId: e.target.value })}
                        disabled={!line.include || !hasTaxCodes}
                        required={line.include}
                        {...control}
                      >
                        <option value="">Choose a tax code</option>
                        {unavailableTax(line.taxCodeId) ? (
                          <option value={line.taxCodeId} disabled>
                            Unavailable tax code
                          </option>
                        ) : null}
                        {(taxCodes ?? []).map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
              </fieldset>
            );
          })}
        </div>
        {err.lines ? (
          <p role="alert" className={styles.status}>
            {err.lines}
          </p>
        ) : null}
      </Panel>
    </form>
  );
}
