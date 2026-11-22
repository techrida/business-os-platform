'use client';

import { CURRENCIES, type Currency, type TaxCode } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { DatePicker } from '@/components/ui/date-picker';
import { EvidenceUpload } from '@/components/ui/evidence-upload';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page';
import { DecimalInput, MoneyInput, QuantityInput } from '@/components/ui/number-input';
import { FactList, Panel } from '@/components/ui/panel';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { currencyChoices } from '@/lib/enabled-currencies';

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
import rows from './line-rows.module.css';

const WIDE = styles.wide ?? '';

/** The picked currency for the number boxes' grouping and prefix; NPR until a known one is chosen. */
const asCurrency = (value: string): Currency =>
  (CURRENCIES as readonly string[]).includes(value) ? (value as Currency) : 'NPR';

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
  enabledCurrencies,
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
  /** The currencies the company has switched on (`currency.enabled`, D44), read once on the server. */
  enabledCurrencies: readonly Currency[];
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
  const [uploadBlocked, setUploadBlocked] = useState(false);
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
            disabled={pending || !hasTaxCodes || hasUnavailableTax || uploadBlocked}
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
            : 'Upload the vendor’s document and type in what it says. The platform works out the totals.'
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
              <EvidenceUpload
                kind="rfq"
                ownerId={rfqId}
                name="documentId"
                label="Quotation document"
                hint="The vendor’s quotation file."
                error={err.documentId}
                onBlockingChange={setUploadBlocked}
                className={WIDE}
              />
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
                {currencyChoices(enabledCurrencies).map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.value}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Valid until" hint="Optional." error={err.validUntil}>
            {(control) => (
              <DatePicker
                {...control}
                name="validUntil"
                value={values.validUntil}
                onChange={(iso) => set('validUntil')({ target: { value: iso } })}
              />
            )}
          </Field>
          <Field label="Delivery time (days)" hint="Optional." error={err.deliveryDays}>
            {(control) => (
              <DecimalInput
                {...control}
                name="deliveryDays"
                intDigits={4}
                scale={0}
                min="0"
                max="3650"
                value={values.deliveryDays}
                onValueChange={(plain) => set('deliveryDays')({ target: { value: plain } })}
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
              <RichTextEditor
                name="terms"
                id={control.id}
                aria-labelledby={control['aria-labelledby']}
                aria-describedby={control['aria-describedby']}
                invalid={control['aria-invalid'] === true}
                value={values.terms}
                onChange={(html) => set('terms')({ target: { value: html } })}
                maxChars={2000}
                minHeight={96}
                disabled={pending}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title="Line items"
        description="One row for each line of the purchase request. Untick a line the vendor did not quote. The platform works out the totals when you save."
      >
        <div className={`${rows.editor} ${rows.quote}`}>
          {/* The column heads; each line's own labels stay for screen readers ("Quantity (line 1)"). */}
          <div className={rows.head} aria-hidden="true">
            <span>#</span>
            <span className={rows.headFields}>
              <span>Item</span>
              <span>Quantity</span>
              <span>Unit price</span>
              <span>Tax code</span>
            </span>
          </div>
          <ol className={rows.lines}>
            {prLines.map((pl, i) => {
              const line = values.lines[i];
              if (line === undefined) return null;
              const lineLabel = (text: string) => (
                <>
                  {text}
                  <span className="sr-only"> (line {pl.lineNo})</span>
                </>
              );
              return (
                <li key={pl.id} className={rows.line}>
                  <input type="hidden" name={`lines.${i}.prLineId`} value={pl.id} />
                  <span className={rows.lineNo}>
                    <span className={rows.lineWord}>Line </span>
                    {pl.lineNo}
                  </span>
                  <div className={rows.fields}>
                    <div className={rows.item}>
                      <label className={rows.include}>
                        <input
                          type="checkbox"
                          name={`lines.${i}.include`}
                          checked={line.include}
                          onChange={(e) => setLine(i, { include: e.target.checked })}
                        />
                        <span className={rows.item}>
                          <span className="sr-only">Quote line {pl.lineNo}: </span>
                          <span className={rows.itemName}>{pl.description}</span>
                          <span className={rows.itemNote}>
                            {pl.quantity} {pl.uom} requested
                          </span>
                        </span>
                      </label>
                    </div>
                    <Field label={lineLabel('Quantity')} error={err[`lines.${i}.quantity`]}>
                      {(control) => (
                        <QuantityInput
                          {...control}
                          name={`lines.${i}.quantity`}
                          uom={pl.uom}
                          currency={asCurrency(values.currency)}
                          value={line.quantity}
                          onValueChange={(plain) => setLine(i, { quantity: plain })}
                          disabled={!line.include}
                        />
                      )}
                    </Field>
                    <Field label={lineLabel('Unit price')} error={err[`lines.${i}.unitPrice`]}>
                      {(control) => (
                        <MoneyInput
                          {...control}
                          name={`lines.${i}.unitPrice`}
                          currency={asCurrency(values.currency)}
                          value={line.unitPrice}
                          onValueChange={(plain) => setLine(i, { unitPrice: plain })}
                          disabled={!line.include}
                        />
                      )}
                    </Field>
                    <Field
                      label={lineLabel('Tax code')}
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
                </li>
              );
            })}
          </ol>
          {err.lines ? (
            <p role="alert" className={styles.status}>
              {err.lines}
            </p>
          ) : null}
        </div>
      </Panel>
    </form>
  );
}
