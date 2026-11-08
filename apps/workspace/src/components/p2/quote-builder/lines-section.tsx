'use client';

import { formatMoney } from '@bos/locale';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';

import type { Currency, LineValues } from './model';
import type { TaxCode } from './schemas';
import styles from './quote-builder.module.css';

export const MAX_LINES = 500;

/** Section 3: the lines. There is no per-line discount; the one discount sits in section 4. */
export function LinesSection({
  lines,
  currency,
  taxCodes,
  lineAmounts,
  errors,
  onChange,
  onAdd,
  onRemove,
}: {
  lines: readonly LineValues[];
  currency: Currency;
  /** null when the list failed to load. */
  taxCodes: readonly TaxCode[] | null;
  /** Server-computed amount per line number (before discount), when a preview has arrived. */
  lineAmounts: ReadonlyMap<number, string>;
  /** Field errors keyed by `lines.<index>.<field>`. */
  errors: Readonly<Record<string, string>>;
  onChange: (key: string, patch: Partial<LineValues>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  const atLimit = lines.length >= MAX_LINES;

  return (
    <div className={styles.sectionBody}>
      {taxCodes === null ? (
        <Alert tone="warning" role="status">
          The tax codes did not load, so a tax code cannot be chosen for a line. Reload the page to
          try again. Your edits are kept until you leave it.
        </Alert>
      ) : taxCodes.length === 0 ? (
        <Alert tone="warning" role="status">
          No tax codes are set up yet. Ask an administrator to add them, then reload.
        </Alert>
      ) : null}

      {lines.length === 0 ? (
        <EmptyState
          title="No lines yet"
          headingLevel={3}
          action={<Button onClick={onAdd}>Add the first line</Button>}
        >
          Add what you are selling. Quantity, unit, rate and tax code are needed for each line.
        </EmptyState>
      ) : (
        <>
          <Table caption="Quotation lines" minWidth={920}>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Description</Th>
                <Th>Unit</Th>
                <Th align="end">Quantity</Th>
                <Th align="end">Rate ({currency})</Th>
                <Th>Tax code</Th>
                <Th align="end">Amount before discount</Th>
                <Th>
                  <span className="sr-only">Remove line</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const no = index + 1;
                const e = (field: string) => errors[`lines.${index}.${field}`];
                const amount = lineAmounts.get(no);
                const label = (what: string) => `Line ${no} ${what}`;
                return (
                  <tr key={line.key}>
                    <Td className={styles.lineNo}>{no}</Td>
                    <Td className={styles.lineCell}>
                      <Textarea
                        aria-label={label('description')}
                        aria-invalid={e('description') ? true : undefined}
                        className={styles.lineText}
                        rows={2}
                        maxLength={500}
                        value={line.description}
                        onChange={(ev) => onChange(line.key, { description: ev.target.value })}
                      />
                      {e('description') ? (
                        <span className={styles.rowError}>{e('description')}</span>
                      ) : null}
                    </Td>
                    <Td className={styles.lineCell}>
                      <Input
                        aria-label={label('unit')}
                        aria-invalid={e('uom') ? true : undefined}
                        maxLength={20}
                        value={line.uom}
                        onChange={(ev) => onChange(line.key, { uom: ev.target.value })}
                      />
                      {e('uom') ? <span className={styles.rowError}>{e('uom')}</span> : null}
                    </Td>
                    <Td align="end" className={styles.lineCell}>
                      <Input
                        aria-label={label('quantity')}
                        aria-invalid={e('quantity') ? true : undefined}
                        inputMode="decimal"
                        autoComplete="off"
                        className={styles.numInput}
                        value={line.quantity}
                        onChange={(ev) => onChange(line.key, { quantity: ev.target.value })}
                      />
                      {e('quantity') ? (
                        <span className={styles.rowError}>{e('quantity')}</span>
                      ) : null}
                    </Td>
                    <Td align="end" className={styles.lineCell}>
                      <Input
                        aria-label={label('rate')}
                        aria-invalid={e('unitPrice') ? true : undefined}
                        inputMode="decimal"
                        autoComplete="off"
                        className={styles.numInput}
                        value={line.unitPrice}
                        onChange={(ev) => onChange(line.key, { unitPrice: ev.target.value })}
                      />
                      {e('unitPrice') ? (
                        <span className={styles.rowError}>{e('unitPrice')}</span>
                      ) : null}
                    </Td>
                    <Td className={styles.lineCell}>
                      <Select
                        aria-label={label('tax code')}
                        aria-invalid={e('taxCodeId') ? true : undefined}
                        disabled={taxCodes === null || taxCodes.length === 0}
                        value={line.taxCodeId}
                        onChange={(ev) => onChange(line.key, { taxCodeId: ev.target.value })}
                      >
                        <option value="">Choose</option>
                        {(taxCodes ?? []).map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                      {e('taxCodeId') ? (
                        <span className={styles.rowError}>{e('taxCodeId')}</span>
                      ) : null}
                    </Td>
                    <Td align="end" className={styles.lineAmount}>
                      {amount !== undefined ? (
                        formatMoney(amount, currency)
                      ) : (
                        <span
                          className={styles.muted}
                          title="Shown once the platform has priced the lines"
                        >
                          not priced yet
                        </span>
                      )}
                    </Td>
                    <Td className={styles.lineCell}>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => onRemove(line.key)}
                        aria-label={`Remove line ${no}`}
                      >
                        Remove
                      </Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={onAdd} disabled={atLimit}>
              Add line
            </Button>
            {atLimit ? (
              <span className={styles.muted}>A quotation holds up to {MAX_LINES} lines.</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
