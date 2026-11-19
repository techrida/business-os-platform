import type { InvoiceDetail } from '@bos/contracts';
import type { CustomerDateFormat, NumberSystems } from '@bos/locale';

import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { money, when } from '@/lib/kernel-format';

import styles from './invoice.module.css';

type Invoice = InvoiceDetail['invoice'];

/** Every figure below is a string the server sent: this file formats, it never adds or rounds. */

/** The NPR value frozen at issue, with the rate that produced it. Only for a foreign-currency invoice. */
export function NprSnapshot({
  invoice,
  numberSystems,
  dateFormat,
}: {
  invoice: Invoice;
  numberSystems: NumberSystems;
  dateFormat?: CustomerDateFormat;
}) {
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
    { key: 'amount', label: 'Value in NPR', value: money(npr.amountNpr, 'NPR', numberSystems) },
    { key: 'rate', label: `Rate (${currency} to NPR)`, value: npr.rate },
    {
      key: 'source',
      label: 'Rate source',
      value: <span className={styles.wrap}>{npr.rateSource}</span>,
    },
    {
      key: 'date',
      label: 'Rate date',
      value: <DayValue iso={npr.rateDate} pattern={dateFormat} />,
    },
  ];
  return (
    <Panel as="aside" title="Value in NPR" description="Exchange rate at issue">
      <FactList facts={facts} />
    </Panel>
  );
}

/**
 * How each line's amount splits: gross, its share of the discount, the taxable base and the VAT. The document shows
 * the customer's columns; this side panel keeps the internal breakdown, one short list per line so it fits a narrow
 * column.
 */
export function LineBreakdown({
  detail,
  numberSystems,
}: {
  detail: InvoiceDetail;
  numberSystems: NumberSystems;
}) {
  const { invoice, lines } = detail;
  const { currency } = invoice;
  if (lines.length === 0) return null;
  return (
    <Panel as="aside" title="Line breakdown" description={`Amounts in ${currency}`}>
      <ol className={styles.breakdown}>
        {lines.map((line) => (
          <li key={line.lineNo} className={styles.breakdownItem}>
            <h3 className={styles.breakdownTitle}>
              <span className={styles.quiet}>{line.lineNo}.</span>{' '}
              <span className={styles.wrap}>{line.description}</span>
            </h3>
            <dl className={styles.totals}>
              {(
                [
                  ['Gross', line.gross],
                  ['Discount', line.discountAlloc],
                  ['Taxable', line.taxable],
                  ['VAT', line.taxAmount],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className={styles.totalRow}>
                  <dt className={styles.totalTerm}>{label}</dt>
                  <dd className={styles.totalValue}>{money(value, currency, numberSystems)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** A date from the server, as a `<time>` with its Kathmandu date. */
export function DayValue({ iso, pattern }: { iso: string; pattern?: CustomerDateFormat | undefined }) {
  return <time dateTime={iso}>{when(iso, 'date', pattern)}</time>;
}
