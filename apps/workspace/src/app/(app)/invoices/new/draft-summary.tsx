'use client';

import type { Currency } from '@bos/contracts';
import { Dec, formatMoney } from '@bos/locale';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { useNumberSystem } from '@/components/ui/number-system-context';
import { Table, Td, Th } from '@/components/ui/table';

import { parseLines, type LineValues } from './lines';
import styles from './manual-invoice.module.css';

export function DraftSummary({
  customer,
  currency,
  lines,
  pending,
}: {
  customer: string | undefined;
  currency: Currency;
  lines: readonly LineValues[];
  pending: boolean;
}) {
  const numberSystem = useNumberSystem();
  const parsed = parseLines(lines);
  const details = parsed.ok
    ? parsed.data.map((line) => ({
        ...line,
        gross: new Dec(line.quantity).times(line.unitPrice).toDecimalPlaces(2),
      }))
    : null;
  const subtotal = details?.reduce((total, line) => total.plus(line.gross), new Dec(0));
  const amount = (value: Dec) => formatMoney(value.toFixed(2), currency, { numberSystem });

  return (
    <div className={styles.summaryArea}>
      <div className={styles.summary}>
        <dl>
          <dt>Subtotal before tax</dt>
          <dd>{subtotal ? amount(subtotal) : '—'}</dd>
        </dl>
        <p>Tax and final totals are calculated when the draft is saved.</p>
      </div>
      <Dialog
        size="large"
        title="Draft invoice preview"
        description="An invoice number, issue date and final totals are assigned through the invoice workflow."
        trigger={
          <Button
            variant="secondary"
            disabled={!customer || !details || pending}
            title={
              !customer || !details
                ? 'Choose a customer and complete each line to preview.'
                : undefined
            }
          >
            <Icon name="file-text" size={18} /> Preview
          </Button>
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
                    {formatMoney(line.unitPrice, currency, { numberSystem })}
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
        </div>
      </Dialog>
    </div>
  );
}
