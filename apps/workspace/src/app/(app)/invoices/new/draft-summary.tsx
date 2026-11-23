'use client';

import type { Currency, Discount } from '@bos/contracts';
import { Dec, formatMoney } from '@bos/locale';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';
import { Icon } from '@/components/ui/icon';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { Table, Td, Th } from '@/components/ui/table';

import { parseLines, type LineValues } from './lines';
import styles from './manual-invoice.module.css';

export function DraftSummary({
  customer,
  currency,
  lines,
  discount,
  pending,
}: {
  customer: string | undefined;
  currency: Currency;
  lines: readonly LineValues[];
  /** The document discount as entered. Shown as typed; the server works out its amount when the draft is saved. */
  discount?: Discount | undefined;
  pending: boolean;
}) {
  const numberSystems = useNumberSystems();
  const parsed = parseLines(lines);
  const details = parsed.ok
    ? parsed.data.map((line) => ({
        ...line,
        gross: new Dec(line.quantity).times(line.unitPrice).toDecimalPlaces(2),
      }))
    : null;
  const subtotal = details?.reduce((total, line) => total.plus(line.gross), new Dec(0));
  const amount = (value: Dec) => formatMoney(value.toFixed(2), currency, { numberSystems });
  const discountText =
    discount === undefined
      ? null
      : discount.mode === 'pct'
        ? `${discount.value}%`
        : formatMoney(discount.value, currency, { numberSystems });

  return (
    <div className={styles.summaryArea}>
      <div className={styles.summary}>
        <dl>
          <dt>Subtotal before tax</dt>
          <dd>{subtotal ? amount(subtotal) : '—'}</dd>
        </dl>
        {discountText !== null ? (
          <dl className={styles.minor}>
            <dt>Discount</dt>
            <dd>{discountText}</dd>
          </dl>
        ) : null}
        <p>
          {discountText !== null
            ? 'The discount, tax and final totals are calculated when the draft is saved.'
            : 'Tax and final totals are calculated when the draft is saved.'}
        </p>
      </div>
      <Dialog
        size="large"
        title="Draft invoice preview"
        description="An invoice number, issue date and final totals are assigned through the invoice workflow."
        trigger={
          <Tooltip
            content={
              !customer || !details
                ? 'Choose a customer and complete each line to preview.'
                : undefined
            }
          >
            <Button
              variant="secondary"
              aria-disabled={!customer || !details || pending || undefined}
              // Still focusable so the tooltip reads; a click on it must not open the dialog.
              onClick={(event) => {
                if (!customer || !details || pending) event.preventDefault();
              }}
            >
              <Icon name="file-text" size={18} /> Preview
            </Button>
          </Tooltip>
        }
        footer={
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        }
      >
        <div className={styles.preview}>
          <div className={styles.previewHeader}>
            <div>
              <span>Invoice to</span>
              <strong>{customer}</strong>
            </div>
            <strong>Draft invoice</strong>
          </div>
          <Table
            caption="Draft invoice line items"
            minWidth={485}
            className={styles.previewItems ?? ''}
          >
            <thead>
              <tr>
                <Th>Description</Th>
                <Th align="end">Quantity</Th>
                <Th align="end">Unit price</Th>
                <Th align="end">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {details?.map((line, index) => (
                <tr key={lines[index]?.key}>
                  <Td>{line.description}</Td>
                  <Td align="end" nowrap>
                    {line.quantity} {line.uom}
                  </Td>
                  <Td align="end" nowrap>
                    {formatMoney(line.unitPrice, currency, { numberSystems })}
                  </Td>
                  <Td align="end" nowrap>
                    {amount(line.gross)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className={styles.previewTotal}>
            Subtotal before tax <strong>{subtotal ? amount(subtotal) : '—'}</strong>
          </p>
          {discountText !== null ? (
            <p className={styles.previewTotal}>
              Discount <strong>{discountText}</strong>
            </p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
