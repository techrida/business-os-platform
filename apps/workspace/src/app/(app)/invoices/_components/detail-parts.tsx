import type { InvoiceDetail } from '@bos/contracts';

import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { money, when } from '@/lib/kernel-format';

import styles from './invoice.module.css';

type Invoice = InvoiceDetail['invoice'];

/** Every figure below is a string the server sent: this file formats, it never adds or rounds. */
export function Totals({ invoice }: { invoice: Invoice }) {
  const { totals, currency } = invoice;
  const rows: { key: string; label: string; value: string; grand?: boolean }[] = [
    { key: 'subtotal', label: 'Subtotal', value: totals.subtotal },
    { key: 'discount', label: 'Discount', value: totals.discountAmount },
    { key: 'taxable', label: 'Taxable amount', value: totals.taxableAmount },
    { key: 'exempt', label: 'Exempt amount', value: totals.exemptAmount },
    { key: 'zero', label: 'Zero-rated amount', value: totals.zeroRatedAmount },
    { key: 'vat', label: 'VAT', value: totals.taxAmount },
    { key: 'total', label: 'Total', value: totals.total, grand: true },
  ];
  return (
    <Panel as="aside" title="Totals" description={`Amounts in ${currency}`}>
      <dl className={styles.totals}>
        {rows.map((row) => (
          <div
            key={row.key}
            className={row.grand ? `${styles.totalRow} ${styles.grandTotal}` : styles.totalRow}
          >
            <dt className={styles.totalTerm}>{row.label}</dt>
            <dd className={styles.totalValue}>{money(row.value, currency)}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/** The NPR value frozen at issue, with the rate that produced it. Only for a foreign-currency invoice. */
export function NprSnapshot({ invoice }: { invoice: Invoice }) {
  const { npr, currency } = invoice;
  if (currency === 'NPR') return null;
  if (npr === null) {
    return (
      <Panel as="aside" title="Value in NPR">
        <p className={styles.note}>
          The NPR value is fixed when the invoice is issued, using the exchange rate on file that
          day. It cannot be changed after that.
        </p>
      </Panel>
    );
  }
  const facts: Fact[] = [
    { key: 'amount', label: 'Value in NPR', value: money(npr.amountNpr, 'NPR') },
    { key: 'rate', label: `Rate (${currency} to NPR)`, value: npr.rate },
    {
      key: 'source',
      label: 'Rate source',
      value: <span className={styles.wrap}>{npr.rateSource}</span>,
    },
    { key: 'date', label: 'Rate date', value: <time dateTime={npr.rateDate}>{npr.rateDate}</time> },
  ];
  return (
    <Panel as="aside" title="Value in NPR" description="Exchange rate at issue">
      <FactList facts={facts} />
    </Panel>
  );
}

export function Lines({ detail }: { detail: InvoiceDetail }) {
  const { invoice, lines, taxSummary } = detail;
  const { currency } = invoice;
  return (
    <>
      <Panel title="Line Items">
        <Table caption="Invoice lines" minWidth={860}>
          <thead>
            <tr>
              <Th align="end">#</Th>
              <Th>Description</Th>
              <Th align="end">Quantity</Th>
              <Th align="end">Unit price</Th>
              <Th align="end">Gross</Th>
              <Th align="end">Discount</Th>
              <Th align="end">Taxable</Th>
              <Th align="end">VAT</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.lineNo}>
                <Td align="end">{line.lineNo}</Td>
                <Td>
                  <span className={styles.lineText}>{line.description}</span>
                </Td>
                <Td align="end" nowrap>
                  <span className={styles.figure}>
                    {line.quantity} {line.uom}
                  </span>
                </Td>
                <Td align="end" nowrap>
                  {money(line.unitPrice, currency)}
                </Td>
                <Td align="end" nowrap>
                  {money(line.gross, currency)}
                </Td>
                <Td align="end" nowrap>
                  {money(line.discountAlloc, currency)}
                </Td>
                <Td align="end" nowrap>
                  {money(line.taxable, currency)}
                </Td>
                <Td align="end" nowrap>
                  {money(line.taxAmount, currency)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
      {taxSummary.length > 0 ? (
        <Panel title="Tax summary">
          <Table caption="Tax summary" minWidth={520}>
            <thead>
              <tr>
                <Th>Tax</Th>
                <Th align="end">Rate</Th>
                <Th align="end">Taxable base</Th>
                <Th align="end">Tax</Th>
              </tr>
            </thead>
            <tbody>
              {taxSummary.map((row) => (
                <tr key={row.taxCodeId}>
                  <Td>
                    <span className={styles.lineText}>{row.label}</span>
                  </Td>
                  <Td align="end" nowrap>
                    {row.percent}%
                  </Td>
                  <Td align="end" nowrap>
                    {money(row.base, currency)}
                  </Td>
                  <Td align="end" nowrap>
                    {money(row.tax, currency)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      ) : null}
    </>
  );
}

/** A date from the server, as a `<time>` with its Kathmandu date. */
export function DayValue({ iso }: { iso: string }) {
  return <time dateTime={iso}>{when(iso, 'date')}</time>;
}
