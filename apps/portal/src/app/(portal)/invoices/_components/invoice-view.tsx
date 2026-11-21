import type { CustomerInvoiceView, PortalDisplay } from '@bos/contracts';
import { amountInWords, bsLongOfDay, formatBsLong } from '@bos/locale';

import { Alert } from '@/components/portal/alert';
import { PdfNotReady } from '@/components/portal/pdf-not-ready';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { ViewDocument } from '@/components/ui/document-viewer';
import type { PortalSettlement } from '@/lib/api.billing';
import { DEFAULT_PORTAL_DISPLAY, displayFormat, taxLineLabel } from '@/lib/display';

import { canPay, KIND_LABEL, SETTLEMENT_LOOK } from './invoice-status';
import styles from './invoice-view.module.css';

type View = CustomerInvoiceView;

/** The label of the document number and the big balance, by kind. */
const WORDING: Record<View['kind'], { number: string; balance: string; to: string }> = {
  tax_invoice: { number: 'Invoice no.', balance: 'Invoice total', to: 'Invoice to' },
  debit_note: { number: 'Debit note no.', balance: 'Debit note total', to: 'Issued to' },
  credit_note: { number: 'Credit note no.', balance: 'Total credited', to: 'Issued to' },
};

const isZero = (amount: string | undefined): boolean =>
  amount === undefined || /^-?0*(\.0*)?$/.test(amount);

/**
 * One issued invoice as the customer sees it, laid out like its printed copy. It reads only
 * `CustomerInvoiceView`, a strict whitelist with no NPR value, FX rate, approval or editor data, so
 * nothing internal can reach this markup. Every amount is the server's string, formatted for display
 * and never computed here. Numbers, dates and the amount in words follow the format the first print
 * used (`view.format`), so the page matches the PDF; an invoice never printed with one stored uses
 * the company's current `display`. `settlement` is the server's derived status; null means the
 * settlement call failed, and the page says so instead of guessing.
 */
export function InvoiceView({
  view,
  settlement,
  display,
}: {
  view: View;
  settlement: PortalSettlement | null;
  display?: PortalDisplay;
}) {
  const effective: PortalDisplay = view.format
    ? { numberSystems: view.format.numberSystems, dateFormat: view.format.dateFormat }
    : (display ?? DEFAULT_PORTAL_DISPLAY);
  const { money: formatAmount, day: formatDay } = displayFormat(effective);
  const money = (amount: string) => formatAmount(amount, view.currency);
  const look = settlement ? SETTLEMENT_LOOK[settlement.settlement] : null;
  const wording = WORDING[view.kind];
  // One BS form everywhere (U16-Q5): `04 Poush 2083 BS`, the issue date's as frozen at issue.
  const dueBs = view.dueDate ? bsLongOfDay(view.dueDate) : null;
  const words = amountInWords(
    view.totals.total,
    view.currency,
    effective.numberSystems[view.currency],
  );
  // The contact the original PDF printed (frozen at print 1, U16-Q4) wins, so the page and every copy agree after the
  // company profile changes; an invoice printed without one stored shows the profile as it is now.
  const contact =
    view.format?.sellerContact !== undefined
      ? view.format.sellerContact
      : (view.sellerContact ?? null);

  return (
    <div className={styles.wrap}>
      <section className={styles.status} aria-label="Payment status">
        <div className={styles.statusRow}>
          <div className={styles.statusLead}>
            {look ? <Badge tone={look.tone}>{look.label}</Badge> : null}
            {settlement ? (
              <dl className={styles.balance}>
                <dt>Amount open</dt>
                <dd>{money(settlement.openAmount)}</dd>
              </dl>
            ) : null}
          </div>
          <div className={styles.actions}>
            {view.file ? (
              <ViewDocument
                name={view.file.filename}
                previewUrl={`/invoices/${view.id}/document/preview`}
                downloadUrl={`/invoices/${view.id}/document`}
                variant="secondary"
                size="small"
                withDownload
              />
            ) : (
              <PdfNotReady failed={view.renderFailed === true} className={styles.muted} />
            )}
            {settlement && canPay(view.kind, settlement.settlement) ? (
              <LinkButton size="small" href={`/payments/new?invoice=${view.id}`}>
                Submit a payment
              </LinkButton>
            ) : null}
          </div>
        </div>
        {settlement === null ? (
          <Alert tone="warning" role="status">
            We could not load the payment status of this invoice just now. Reload the page to try
            again.
          </Alert>
        ) : null}
        {settlement && settlement.settlement === 'overdue' ? (
          <p className={styles.muted}>
            This invoice is {settlement.daysOverdue} {settlement.daysOverdue === 1 ? 'day' : 'days'}{' '}
            past its due date.
          </p>
        ) : null}
        {view.file ? (
          <p className={styles.checksum}>
            {view.file.filename}
            <span className={styles.visuallyHidden}>, </span>
            <span>
              SHA-256 <code className={styles.hash}>{view.file.sha256}</code>
            </span>
          </p>
        ) : null}
      </section>

      <article className={styles.paper} aria-labelledby="invoice-title">
        <div className={styles.sheet}>
          <header className={styles.head}>
            {/* A company logo goes before the name here once the profile carries one. */}
            <div className={styles.brand}>
              <p className={styles.brandName}>{view.seller.legalName}</p>
            </div>
            <h1 id="invoice-title" className={styles.title}>
              {KIND_LABEL[view.kind]}
              <span className={styles.visuallyHidden}> {view.number}</span>
            </h1>
          </header>

          <div className={styles.billing}>
            <section className={styles.billTo} aria-labelledby="invoice-to">
              <h2 id="invoice-to" className={styles.label}>
                {wording.to}
              </h2>
              <p className={styles.buyerName}>{view.buyer.legalName}</p>
              {view.buyer.address ? (
                <address className={`${styles.address} ${styles.small}`}>
                  {view.buyer.address}
                </address>
              ) : null}
              {view.buyer.panVatNo ? (
                <p className={styles.small}>PAN/VAT {view.buyer.panVatNo}</p>
              ) : null}
            </section>

            <dl className={styles.details}>
              <div>
                <dt>{wording.number}</dt>
                <dd>{view.number}</dd>
              </div>
              <div>
                <dt>Issue date</dt>
                <dd>
                  {formatDay(view.issueDate)}
                  <span className={styles.bs}>{formatBsLong(view.issueDateBs)}</span>
                </dd>
              </div>
              <div>
                <dt>Due date</dt>
                <dd>
                  {view.dueDate ? formatDay(view.dueDate) : 'On receipt'}
                  {dueBs ? <span className={styles.bs}>{dueBs}</span> : null}
                </dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{view.currency}</dd>
              </div>
            </dl>
          </div>

          <div className={styles.itemsFrame}>
            <table className={styles.items}>
              <caption className={styles.visuallyHidden}>Items, in {view.currency}</caption>
              <thead>
                <tr>
                  <th scope="col" className={styles.num}>
                    #
                  </th>
                  <th scope="col">Description</th>
                  <th scope="col" className={styles.num}>
                    Unit price
                  </th>
                  <th scope="col" className={styles.num}>
                    Quantity
                  </th>
                  <th scope="col" className={styles.num}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((line) => (
                  <tr key={line.lineNo}>
                    <td className={`${styles.num} ${styles.lineNo}`}>{line.lineNo}</td>
                    <td className={styles.description}>{line.description}</td>
                    <td className={styles.num}>
                      <span className={styles.cellLabel}>Unit price</span>
                      <span>{money(line.unitPrice)}</span>
                    </td>
                    <td className={styles.num}>
                      <span className={styles.cellLabel}>Quantity</span>
                      <span>
                        {line.quantity} <span className={styles.unit}>{line.uom}</span>
                      </span>
                    </td>
                    <td className={styles.num}>
                      <span className={styles.cellLabel}>Amount</span>
                      <span>{money(line.amount)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.summary}>
            <div className={styles.due}>
              <p className={styles.dueLabel}>{wording.balance}</p>
              <p className={styles.dueAmount}>{money(view.totals.total)}</p>
              {view.kind === 'credit_note' && !view.dueDate ? null : (
                <p className={styles.dueWhen}>
                  {view.dueDate ? `Due ${formatDay(view.dueDate)}` : 'Due on receipt'}
                </p>
              )}
            </div>

            <dl className={styles.totals}>
              <div>
                <dt>Subtotal</dt>
                <dd>{money(view.totals.subtotal)}</dd>
              </div>
              {!isZero(view.totals.discountAmount) ? (
                <div>
                  <dt>Discount</dt>
                  <dd>−{money(view.totals.discountAmount)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Taxable amount</dt>
                <dd>{money(view.totals.taxableAmount)}</dd>
              </div>
              {view.totals.exemptAmount !== undefined && !isZero(view.totals.exemptAmount) ? (
                <div>
                  <dt>Exempt amount</dt>
                  <dd>{money(view.totals.exemptAmount)}</dd>
                </div>
              ) : null}
              {view.totals.zeroRatedAmount !== undefined && !isZero(view.totals.zeroRatedAmount) ? (
                <div>
                  <dt>Zero-rated amount</dt>
                  <dd>{money(view.totals.zeroRatedAmount)}</dd>
                </div>
              ) : null}
              {view.taxSummary.map((t) => (
                <div key={`${t.label}-${t.percent}`}>
                  <dt>
                    {taxLineLabel(t.label, t.percent)} on {money(t.base)}
                  </dt>
                  <dd>{money(t.tax)}</dd>
                </div>
              ))}
              {view.taxSummary.length === 0 ? (
                <div>
                  <dt>Tax</dt>
                  <dd>{money(view.totals.taxAmount)}</dd>
                </div>
              ) : null}
              <div className={styles.grandTotal}>
                <dt>Total</dt>
                <dd>{money(view.totals.total)}</dd>
              </div>
            </dl>
          </div>

          <p className={styles.words}>
            Amount in words: <span>{words}</span>
          </p>

          {contact?.signatoryName ? (
            <div className={styles.signatory}>
              <p className={styles.signatoryName}>{contact.signatoryName}</p>
              <p className={styles.small}>{contact.signatoryTitle ?? 'Authorised signatory'}</p>
            </div>
          ) : null}
        </div>

        <SellerFooter seller={view.seller} contact={contact} />
      </article>
    </div>
  );
}

/**
 * How to reach the seller. The address and PAN/VAT number are the ones frozen on the invoice; the
 * phones and email come from the company profile as it is now, and are left out when it is unknown.
 */
function SellerFooter({
  seller,
  contact,
}: {
  seller: View['seller'];
  contact: NonNullable<View['sellerContact']> | null;
}) {
  const phones = contact?.phones.filter((p) => p.trim() !== '') ?? [];
  const email = contact?.email ?? null;
  if (phones.length === 0 && !seller.address && !email && !seller.panVatNo) return null;

  return (
    <footer className={styles.footer}>
      {phones.length > 0 ? (
        <div>
          <p className={styles.muted}>{phones.length === 1 ? 'Phone' : 'Phones'}</p>
          {phones.map((phone) => (
            <a key={phone} href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
              {phone}
            </a>
          ))}
        </div>
      ) : null}
      {seller.address ? (
        <div>
          <p className={styles.muted}>Address</p>
          <address className={styles.address}>{seller.address}</address>
        </div>
      ) : null}
      {email || seller.panVatNo ? (
        <div>
          {email ? (
            <>
              <p className={styles.muted}>Email</p>
              <a href={`mailto:${email}`}>{email}</a>
            </>
          ) : null}
          {seller.panVatNo ? <p>PAN/VAT {seller.panVatNo}</p> : null}
        </div>
      ) : null}
    </footer>
  );
}
