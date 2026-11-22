import { formatPhoneForPrint, type InvoiceDetail, type InvoiceKind } from '@bos/contracts';
import { useId, type ReactNode } from 'react';

import { money } from '@/lib/kernel-format';
import type { SellerContact } from '@/lib/display-settings';

import { InvoiceStatusBadge } from '../badges';

import { daysToPay, documentDate, totalInWords, type DocumentFormat } from './format';
import styles from './invoice-document.module.css';

/** The same titles the PDF prints. */
const TITLES: Record<InvoiceKind, string> = {
  tax_invoice: 'Tax Invoice',
  proforma: 'Proforma Invoice',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
};

/** The label of the document number and of the party block, as the PDF and the portal print them. */
const WORDING: Record<InvoiceKind, { number: string; to: string }> = {
  tax_invoice: { number: 'Invoice no.', to: 'Invoice to' },
  proforma: { number: 'Invoice no.', to: 'Invoice to' },
  credit_note: { number: 'Credit note no.', to: 'Issued to' },
  debit_note: { number: 'Debit note no.', to: 'Issued to' },
};

const DUE_LABELS: Record<InvoiceKind, string> = {
  tax_invoice: 'Invoice total',
  proforma: 'Total',
  credit_note: 'Total credit',
  debit_note: 'Debit note total',
};

const ZERO = /^-?0+(\.0+)?$/;

/** A calendar date with its Bikram Sambat form under it. */
function DateText({ iso, bs, format }: { iso: string; bs: string | null; format: DocumentFormat }) {
  const date = documentDate(iso, bs, format.dateFormat);
  return (
    <>
      <time dateTime={iso}>{date.ad}</time>
      {date.bs !== null ? <span className={styles.bs}>({date.bs})</span> : null}
    </>
  );
}

/**
 * The invoice as the customer receives it (Figma printable invoice, frame 606:8924), drawn from the same figures the
 * PDF prints: company block, title, who it is billed to, the details, the items, the totals, the amount in words,
 * the signatory and the seller's contact lines. Numbers and dates follow `format` (the first print's, else today's
 * settings). A draft has no number, issue date or frozen seller and buyer yet; those places say so.
 *
 * Every figure is a string the server sent: this file formats, it never adds or rounds.
 */
export function InvoiceDocument({
  detail,
  customerName,
  format,
  sellerContact,
  logo,
}: {
  detail: InvoiceDetail;
  /** The buyer's name: frozen at issue, else the customer's current name. */
  customerName: string | undefined;
  format: DocumentFormat;
  sellerContact: SellerContact | null;
  /** A company logo for the company block. Nothing is drawn without one. */
  logo?: ReactNode;
}) {
  const titleId = useId();
  const { invoice, lines, taxSummary } = detail;
  const { currency, totals, seller, buyer } = invoice;
  const amount = (value: string) => money(value, currency, format.numberSystems);
  const days = daysToPay(invoice.issueDate, invoice.dueDate);
  const words = totalInWords(totals.total, currency, format.numberSystems);

  const totalRows: { key: string; label: string; value: string }[] = [
    { key: 'subtotal', label: 'Subtotal', value: amount(totals.subtotal) },
  ];
  if (!ZERO.test(totals.discountAmount)) {
    totalRows.push({
      key: 'discount',
      label: 'Discount',
      value: `- ${amount(totals.discountAmount)}`,
    });
  }
  totalRows.push({ key: 'taxable', label: 'Taxable amount', value: amount(totals.taxableAmount) });
  if (!ZERO.test(totals.exemptAmount)) {
    totalRows.push({ key: 'exempt', label: 'Exempt amount', value: amount(totals.exemptAmount) });
  }
  if (!ZERO.test(totals.zeroRatedAmount)) {
    totalRows.push({
      key: 'zero',
      label: 'Zero-rated amount',
      value: amount(totals.zeroRatedAmount),
    });
  }
  // VAT by tax code, each on its own base, as the PDF prints it.
  if (taxSummary.length > 0) {
    for (const t of taxSummary) {
      totalRows.push({
        key: `tax-${t.taxCodeId}`,
        label: `${t.label} (${t.percent}%) on ${amount(t.base)}`,
        value: amount(t.tax),
      });
    }
  } else {
    totalRows.push({ key: 'tax', label: 'VAT', value: amount(totals.taxAmount) });
  }

  const phones =
    sellerContact?.phones.filter((p) => p.trim() !== '').map(formatPhoneForPrint) ?? [];
  const contact: { key: string; label: string; values: string[] }[] = [
    { key: 'phone', label: phones.length > 1 ? 'Phones' : 'Phone', values: phones },
    { key: 'address', label: 'Address', values: seller?.address ? [seller.address] : [] },
    { key: 'email', label: 'Email', values: sellerContact?.email ? [sellerContact.email] : [] },
    { key: 'pan', label: 'PAN/VAT', values: seller?.panVatNo ? [seller.panVatNo] : [] },
  ].filter((c) => c.values.length > 0);

  return (
    <article className={styles.sheet} aria-labelledby={titleId}>
      <div className={styles.body}>
        <header className={styles.head}>
          <div className={styles.brand}>
            {logo ? <div className={styles.logo}>{logo}</div> : null}
            {seller !== null ? (
              <p className={styles.brandName}>{seller.legalName}</p>
            ) : (
              <p className={styles.brandPending}>The seller details are fixed when it is issued.</p>
            )}
          </div>
          <div className={styles.titleBlock}>
            <h2 id={titleId} className={styles.title}>
              {TITLES[invoice.kind]}
            </h2>
            <InvoiceStatusBadge status={invoice.status} />
          </div>
        </header>

        {invoice.kind === 'proforma' ? (
          <p className={styles.notice}>Proforma Invoice - not a tax invoice.</p>
        ) : null}

        <div className={styles.billing}>
          <section aria-labelledby={`${titleId}-to`}>
            <h3 id={`${titleId}-to`} className={styles.label}>
              {WORDING[invoice.kind].to}
            </h3>
            <p className={styles.buyer}>{customerName ?? 'Customer details unavailable'}</p>
            {buyer?.panVatNo ? <p className={styles.partyLine}>PAN/VAT {buyer.panVatNo}</p> : null}
            {buyer?.address ? <p className={styles.partyLine}>{buyer.address}</p> : null}
            {buyer === null ? (
              <p className={styles.partyLine}>The billing details are fixed when it is issued.</p>
            ) : null}
          </section>

          <dl className={styles.meta}>
            <div className={styles.metaRow}>
              <dt>{WORDING[invoice.kind].number}</dt>
              <dd>{invoice.number ?? <span className={styles.quiet}>Not numbered yet</span>}</dd>
            </div>
            <div className={styles.metaRow}>
              <dt>Issue date</dt>
              <dd>
                {invoice.issueDate !== null ? (
                  <DateText iso={invoice.issueDate} bs={invoice.issueDateBs} format={format} />
                ) : (
                  <span className={styles.quiet}>Set when the invoice is issued</span>
                )}
              </dd>
            </div>
            <div className={styles.metaRow}>
              <dt>Due date</dt>
              <dd>
                {invoice.dueDate !== null ? (
                  <DateText iso={invoice.dueDate} bs={null} format={format} />
                ) : (
                  <span className={styles.quiet}>None</span>
                )}
              </dd>
            </div>
            <div className={styles.metaRow}>
              <dt>Currency</dt>
              <dd>{currency}</dd>
            </div>
          </dl>
        </div>

        <table className={styles.items} role="table">
          <caption className="sr-only">Items</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">
                #
              </th>
              <th scope="col" role="columnheader">
                Description
              </th>
              <th scope="col" role="columnheader">
                Unit
              </th>
              <th scope="col" role="columnheader" className={styles.end}>
                Qty
              </th>
              <th scope="col" role="columnheader" className={styles.end}>
                Price
              </th>
              <th scope="col" role="columnheader" className={styles.end}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {lines.map((line) => (
              <tr key={line.lineNo} role="row">
                <td role="cell" className={styles.lineNo} data-label="#">
                  {String(line.lineNo).padStart(2, '0')}
                </td>
                <td role="cell" className={styles.description} data-label="Description">
                  {line.description}
                </td>
                <td role="cell" data-label="Unit">
                  {line.uom}
                </td>
                <td role="cell" className={`${styles.end} ${styles.figure}`} data-label="Qty">
                  {line.quantity}
                </td>
                <td role="cell" className={`${styles.end} ${styles.figure}`} data-label="Price">
                  {amount(line.unitPrice)}
                </td>
                <td role="cell" className={`${styles.end} ${styles.figure}`} data-label="Amount">
                  {amount(line.gross)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className={styles.balance}>
          <section aria-labelledby={`${titleId}-due`}>
            <h3 id={`${titleId}-due`} className={styles.label}>
              {DUE_LABELS[invoice.kind]}
            </h3>
            <p className={`${styles.dueAmount} ${styles.figure}`}>{amount(totals.total)}</p>
            {invoice.dueDate !== null ? (
              <p className={styles.dueLine}>
                Due{' '}
                <time dateTime={invoice.dueDate}>
                  {documentDate(invoice.dueDate, null, format.dateFormat).ad}
                </time>
                {days !== null ? ` · ${days} ${days === 1 ? 'day' : 'days'}` : null}
              </p>
            ) : null}
          </section>
          <dl className={styles.totals}>
            {totalRows.map((row) => (
              <div key={row.key} className={styles.totalRow}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
            <div className={`${styles.totalRow} ${styles.grand}`}>
              <dt>Total</dt>
              <dd>{amount(totals.total)}</dd>
            </div>
          </dl>
        </div>

        {words !== null ? <p className={styles.words}>Amount in words: {words}</p> : null}

        <div className={styles.sign}>
          {sellerContact?.signatoryName ? (
            <span className={styles.signName}>{sellerContact.signatoryName}</span>
          ) : null}
          {sellerContact?.signatoryTitle ? <span>{sellerContact.signatoryTitle}</span> : null}
          <span className={styles.quiet}>Authorised signatory</span>
        </div>
      </div>

      {contact.length > 0 ? (
        <footer>
          <dl className={styles.foot}>
            {contact.map((c) => (
              <div key={c.key}>
                <dt>{c.label}</dt>
                {c.values.map((v, i) => (
                  <dd key={i}>{v}</dd>
                ))}
              </div>
            ))}
          </dl>
        </footer>
      ) : null}
    </article>
  );
}
