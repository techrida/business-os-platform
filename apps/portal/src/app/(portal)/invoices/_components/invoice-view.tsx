import type { CustomerInvoiceView, PortalDisplay } from '@bos/contracts';

import { Alert } from '@/components/portal/alert';
import styles from '@/components/portal/quotation.module.css';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ViewDocument } from '@/components/ui/document-viewer';
import type { PortalSettlement } from '@/lib/api.billing';
import { displayFormat } from '@/lib/display';

import { canPay, KIND_LABEL, SETTLEMENT_LOOK } from './invoice-status';

type View = CustomerInvoiceView;

/**
 * One issued invoice as the customer sees it. It reads only `CustomerInvoiceView`, a strict
 * whitelist with no NPR value, FX rate, approval or editor data, so nothing internal can reach this
 * markup. Every amount is the server's string, formatted for display and never computed here.
 * `settlement` is the server's derived status; null means the settlement call failed, and the page
 * says so instead of guessing.
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
  const { money: formatAmount, day: formatDay } = displayFormat(display);
  const money = (amount: string) => formatAmount(amount, view.currency);
  const hasDiscount = !/^0+(\.0+)?$/.test(view.totals.discountAmount);
  const look = settlement ? SETTLEMENT_LOOK[settlement.settlement] : null;

  return (
    <div className={styles.document}>
      <header className={styles.docHead}>
        <div className={styles.titleRow}>
          <h1 className={styles.docTitle}>
            {view.number} <span className={styles.revision}>{KIND_LABEL[view.kind]}</span>
          </h1>
          {look ? <Badge tone={look.tone}>{look.label}</Badge> : null}
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Issued</dt>
            <dd>
              {formatDay(view.issueDate)}
              <span className={styles.muted}> · BS {view.issueDateBs}</span>
            </dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{view.dueDate ? formatDay(view.dueDate) : 'On receipt'}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd className={styles.factTotal}>{money(view.totals.total)}</dd>
          </div>
          {settlement ? (
            <div>
              <dt>Amount open</dt>
              <dd className={styles.factTotal}>{money(settlement.openAmount)}</dd>
            </div>
          ) : null}
        </dl>
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
        <div className={styles.download}>
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
            <p className={styles.muted}>The PDF copy is being prepared.</p>
          )}
          {settlement && canPay(view.kind, settlement.settlement) ? (
            <LinkButton size="small" href={`/payments/new?invoice=${view.id}`}>
              Submit a payment
            </LinkButton>
          ) : null}
        </div>
        {view.file ? (
          <p className={styles.checksum}>
            {view.file.filename}
            <span className={styles.visuallyHidden}>, </span>
            <span>
              SHA-256 <code className={styles.hash}>{view.file.sha256}</code>
            </span>
          </p>
        ) : null}
      </header>

      <Card as="section" aria-labelledby="parties-h" className={styles.section}>
        <h2 id="parties-h" className={styles.sectionTitle}>
          Parties
        </h2>
        <div className={styles.parties}>
          <PartyBlock heading="From" party={view.seller} />
          <PartyBlock heading="To" party={view.buyer} />
        </div>
      </Card>

      <Card as="section" aria-labelledby="lines-h" className={styles.section}>
        <h2 id="lines-h" className={styles.sectionTitle}>
          Items
        </h2>
        <div className={styles.tableFrame}>
          <table className={styles.table}>
            <caption className={styles.visuallyHidden}>Items, in {view.currency}</caption>
            <thead>
              <tr>
                <th scope="col" className={styles.num}>
                  #
                </th>
                <th scope="col">Description</th>
                <th scope="col" className={styles.num}>
                  Quantity
                </th>
                <th scope="col" className={styles.num}>
                  Unit price
                </th>
                <th scope="col" className={styles.num}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((line) => (
                <tr key={line.lineNo}>
                  <td className={styles.num}>{line.lineNo}</td>
                  <td className={styles.description}>{line.description}</td>
                  <td className={`${styles.num} ${styles.nowrap}`}>
                    {line.quantity} {line.uom}
                  </td>
                  <td className={`${styles.num} ${styles.nowrap}`}>{money(line.unitPrice)}</td>
                  <td className={`${styles.num} ${styles.nowrap}`}>{money(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className={styles.totals}>
          <div>
            <dt>Subtotal</dt>
            <dd>{money(view.totals.subtotal)}</dd>
          </div>
          {hasDiscount ? (
            <div>
              <dt>Discount</dt>
              <dd>−{money(view.totals.discountAmount)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Taxable amount</dt>
            <dd>{money(view.totals.taxableAmount)}</dd>
          </div>
          {view.taxSummary.map((t) => (
            <div key={`${t.label}-${t.percent}`}>
              <dt>
                {t.label} {t.percent}% on {money(t.base)}
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
      </Card>
    </div>
  );
}

function PartyBlock({ heading, party }: { heading: string; party: View['seller'] }) {
  return (
    <div className={styles.party}>
      <h3 className={styles.partyHeading}>{heading}</h3>
      <p className={styles.partyName}>{party.legalName}</p>
      {party.address ? <address className={styles.address}>{party.address}</address> : null}
      {party.panVatNo ? <p className={styles.muted}>PAN/VAT {party.panVatNo}</p> : null}
    </div>
  );
}
