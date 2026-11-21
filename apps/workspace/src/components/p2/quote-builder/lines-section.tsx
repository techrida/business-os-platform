'use client';

import { QuotationLineInputSchema } from '@bos/contracts';
import { formatMoney } from '@bos/locale';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { MoneyInput, QuantityInput } from '@/components/ui/number-input';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { Table, Td, Th } from '@/components/ui/table';

import { newLine, type Currency, type LineValues } from './model';
import styles from './quote-builder.module.css';
import type { TaxCode } from './schemas';

const MAX_LINES = 500;

const LINE_ERRORS = {
  description: 'Enter a description, up to 500 characters.',
  uom: 'Enter a unit, up to 20 characters.',
  quantity: 'Enter a quantity above zero, up to 14 whole digits and 4 decimal places.',
  unitPrice: 'Enter a rate of zero or more, up to 16 whole digits and 2 decimal places.',
  taxCodeId: 'Choose a tax code.',
};

type EditableField = keyof typeof LINE_ERRORS;

function LineEditor({
  line,
  currency,
  taxCodes,
  trigger,
  errors = {},
  onSave,
}: {
  line?: LineValues;
  currency: Currency;
  taxCodes: readonly TaxCode[];
  trigger: ReactNode;
  errors?: Partial<Record<EditableField, string>>;
  onSave: (line: LineValues) => void;
}) {
  const formId = useId();
  const form = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => line ?? newLine(''));
  const [fieldErrors, setFieldErrors] = useState(errors);

  function change(field: EditableField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors(({ [field]: _error, ...rest }) => rest);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = {
      description: draft.description.trim(),
      uom: draft.uom.trim(),
      quantity: draft.quantity.replace(/^\./, '0.'),
      unitPrice: draft.unitPrice.replace(/^\./, '0.'),
      taxCodeId: draft.taxCodeId,
    };
    const result = QuotationLineInputSchema.safeParse(normalized);
    if (!result.success) {
      const nextErrors: Partial<Record<EditableField, string>> = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0] as EditableField;
        nextErrors[field] = LINE_ERRORS[field];
      }
      setFieldErrors(nextErrors);
      const first = Object.keys(nextErrors)[0];
      // A number field posts through a hidden input; focus its visible box instead.
      const named = form.current?.querySelector<HTMLElement>(`[name="${first}"]`);
      const target =
        named instanceof HTMLInputElement && named.type === 'hidden'
          ? named.parentElement?.querySelector<HTMLElement>('input:not([type="hidden"])')
          : named;
      target?.focus();
      return;
    }
    // Copy the whole line, including its identity and any saved catalog and cost metadata.
    onSave({ ...draft, ...normalized });
    setOpen(false);
  }

  const savedTaxMissing =
    Boolean(draft.taxCodeId) && !taxCodes.some((t) => t.id === draft.taxCodeId);

  return (
    <Dialog
      trigger={trigger}
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(line ?? newLine(''));
          setFieldErrors(errors);
        }
        setOpen(next);
      }}
      title={line ? 'Edit line' : 'Add line'}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId}>
            {line ? 'Save line' : 'Add line'}
          </Button>
        </>
      }
    >
      <form id={formId} ref={form} className={styles.sectionBody} noValidate onSubmit={save}>
        <Field label="Description" error={fieldErrors.description}>
          {(control) => (
            <Textarea
              {...control}
              name="description"
              required
              rows={3}
              maxLength={500}
              value={draft.description}
              onChange={(e) => change('description', e.target.value)}
            />
          )}
        </Field>
        <div className={styles.grid2}>
          <Field label="Quantity" error={fieldErrors.quantity}>
            {(control) => (
              <QuantityInput
                {...control}
                name="quantity"
                required
                currency={currency}
                uom={draft.uom.trim() || undefined}
                value={draft.quantity}
                onValueChange={(value) => change('quantity', value)}
              />
            )}
          </Field>
          <Field label="Unit" error={fieldErrors.uom}>
            {(control) => (
              <Input
                {...control}
                name="uom"
                required
                maxLength={20}
                value={draft.uom}
                onChange={(e) => change('uom', e.target.value)}
              />
            )}
          </Field>
          <Field label={`Rate (${currency})`} error={fieldErrors.unitPrice}>
            {(control) => (
              <MoneyInput
                {...control}
                name="unitPrice"
                required
                currency={currency}
                value={draft.unitPrice}
                onValueChange={(value) => change('unitPrice', value)}
              />
            )}
          </Field>
          <Field label="Tax code" error={fieldErrors.taxCodeId}>
            {(control) => (
              <Select
                {...control}
                name="taxCodeId"
                required
                value={draft.taxCodeId}
                onChange={(e) => change('taxCodeId', e.target.value)}
              >
                <option value="">Choose a tax code</option>
                {savedTaxMissing ? <option value={draft.taxCodeId}>Current tax code</option> : null}
                {taxCodes.map((tax) => (
                  <option key={tax.id} value={tax.id}>
                    {tax.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </form>
    </Dialog>
  );
}

export function LinesSection({
  lines,
  currency,
  taxCodes,
  lineAmounts,
  errors,
  onSave,
  onRemove,
  totals,
}: {
  lines: readonly LineValues[];
  currency: Currency;
  taxCodes: readonly TaxCode[] | null;
  lineAmounts: ReadonlyMap<number, string>;
  errors: Readonly<Record<string, string>>;
  onSave: (line: LineValues) => void;
  onRemove: (key: string) => void;
  totals: ReactNode;
}) {
  const numberSystems = useNumberSystems();
  const addRef = useRef<HTMLButtonElement>(null);
  const atLimit = lines.length >= MAX_LINES;
  const codes = taxCodes ?? [];
  const taxById = new Map(codes.map((tax) => [tax.id, tax]));
  const canAdd = !atLimit && codes.length > 0;

  return (
    <div className={styles.sectionBody}>
      <div className={styles.lineToolbar}>
        <h2>Line items</h2>
        <LineEditor
          currency={currency}
          taxCodes={codes}
          onSave={onSave}
          trigger={
            <Button ref={addRef} variant="tertiary" disabled={!canAdd}>
              <span aria-hidden="true">+</span> Add line
            </Button>
          }
        />
      </div>
      {codes.length === 0 ? (
        <Alert tone="warning" role="status">
          {taxCodes === null
            ? 'Tax codes could not load. Reload the page to add a line.'
            : 'Set up a tax code before adding a line.'}
        </Alert>
      ) : null}
      {errors.lines ? <p className={styles.rowError}>{errors.lines}</p> : null}
      {atLimit ? <span className={styles.muted}>Up to {MAX_LINES} lines.</span> : null}
      {lines.length === 0 ? (
        <p className={styles.linesEmpty}>Add a product or service to this quotation.</p>
      ) : (
        <Table caption="Quotation lines" minWidth={640} className={styles.lineTable ?? ''}>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Product / service</Th>
              <Th align="end">Quantity</Th>
              <Th align="end">Unit price</Th>
              <Th>Tax code</Th>
              <Th align="end">Before discount</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const no = index + 1;
              const amount = lineAmounts.get(no);
              const tax = taxById.get(line.taxCodeId);
              const fieldErrors = Object.fromEntries(
                Object.keys(LINE_ERRORS).flatMap((field) => {
                  const error = errors[`lines.${index}.${field}`];
                  return error ? [[field, error]] : [];
                }),
              );
              return (
                <tr key={line.key}>
                  <Td className={styles.lineNumber}>{no}</Td>
                  <Td className={styles.lineDescription}>
                    <span className={styles.lineItem}>{line.description}</span>
                    {Object.values(fieldErrors).map((error) => (
                      <span key={error} className={styles.rowError}>
                        {error}
                      </span>
                    ))}
                  </Td>
                  <Td align="end">
                    {line.quantity} {line.uom}
                  </Td>
                  <Td align="end">{formatMoney(line.unitPrice, currency, { numberSystems })}</Td>
                  <Td>{tax?.label ?? 'Current tax code'}</Td>
                  <Td align="end">
                    {amount === undefined ? (
                      <span aria-label="Amount unavailable">—</span>
                    ) : (
                      formatMoney(amount, currency, { numberSystems })
                    )}
                  </Td>
                  <Td>
                    <div className={styles.lineActions}>
                      <LineEditor
                        line={line}
                        currency={currency}
                        taxCodes={codes}
                        errors={fieldErrors}
                        onSave={onSave}
                        trigger={
                          <Button
                            variant="ghost"
                            size="small"
                            aria-label={`Edit line ${no}: ${line.description}`}
                          >
                            Edit
                          </Button>
                        }
                      />
                      <ConfirmDialog
                        trigger={
                          <Button
                            variant="ghost"
                            size="small"
                            aria-label={`Remove line ${no}: ${line.description}`}
                          >
                            <svg
                              aria-hidden="true"
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6" />
                            </svg>
                          </Button>
                        }
                        title="Remove line?"
                        description="This line will be removed from the draft."
                        confirmLabel="Remove line"
                        destructive
                        onConfirm={() => {
                          onRemove(line.key);
                          requestAnimationFrame(() => addRef.current?.focus());
                        }}
                      >
                        <p className={styles.lineDescription}>{line.description}</p>
                      </ConfirmDialog>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <div className={styles.lineFooter}>{totals}</div>
    </div>
  );
}
