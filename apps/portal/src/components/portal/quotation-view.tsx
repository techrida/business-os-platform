import { trimPercent, type CustomerQuotationView } from '@bos/contracts';
import { formatMoney } from '@bos/locale';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import styles from './quotation.module.css';
import { displayStatus, formatDay, STATUS_LOOK } from './quotation-status';

type View = CustomerQuotationView;
type Party = View['issuer'];

/**
 * One quotation as the customer sees it. It reads only `CustomerQuotationView`, a strict whitelist
 * with no cost, margin, FX or approval data, so nothing internal can reach this markup. A test
 * renders it and scans the words. `respond` is the accept/reject panel the page puts beside it.
 */
export function QuotationView({
  view,
  today,
  respond,
}: {
  view: View;
  today: string;
  respond?: ReactNode;
}) {
  const look = STATUS_LOOK[displayStatus(view.status, view.validUntil, today)];
  const money = (amount: string) => formatMoney(amount, view.currency);
  const hasDiscount = !/^0+(\.0+)?$/.test(view.totals.discountAmount);

  return (
    <div className={styles.layout}>
      <div className={styles.document}>
        <header className={styles.docHead}>
          <div className={styles.titleRow}>
            <h1 className={styles.docTitle}>
              {view.number} <span className={styles.revision}>Rev {view.revisionNo}</span>
            </h1>
            <Badge tone={look.tone}>{look.label}</Badge>
          </div>
          <dl className={styles.facts}>
            <div>
              <dt>Issued</dt>
              <dd>{formatDay(view.issueDate)}</dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd>{formatDay(view.validUntil)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd className={styles.factTotal}>{money(view.totals.total)}</dd>
            </div>
          </dl>
          {view.file ? (
            <div className={styles.download}>
              {/* A plain anchor: the target is a route handler, and a prefetch would fetch the PDF. No
                  `download` attribute: the API sends attachment, and an error must read as text. */}
              <LinkButton variant="secondary" size="small" href={`/quotations/${view.id}/document`}>
                Download PDF
              </LinkButton>
              <p className={styles.checksum}>
                {view.file.filename}
                <span className={styles.visuallyHidden}>, </span>
                <span>
                  SHA-256 <code className={styles.hash}>{view.file.sha256}</code>
                </span>
              </p>
            </div>
          ) : (
            <p className={styles.muted}>The PDF copy is being prepared.</p>
          )}
        </header>

        <Card as="section" aria-labelledby="parties-h" className={styles.section}>
          <h2 id="parties-h" className={styles.sectionTitle}>
            Parties
          </h2>
          <div className={styles.parties}>
            <PartyBlock heading="From" party={view.issuer} />
            <PartyBlock heading="To" party={view.customer} />
            {view.contact ? (
              <div className={styles.party}>
                <h3 className={styles.partyHeading}>Attention</h3>
                <p>{view.contact.fullName}</p>
                {view.contact.email ? <p className={styles.muted}>{view.contact.email}</p> : null}
              </div>
            ) : null}
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
                  {t.label} {t.percent}%
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

        <Card as="section" aria-labelledby="terms-h" className={styles.section}>
          <h2 id="terms-h" className={styles.sectionTitle}>
            Terms
          </h2>
          <dl className={styles.terms}>
            <Term label="Scope" value={view.scope} />
            <Term label="Assumptions" value={view.assumptions} />
            <Term label="Exclusions" value={view.exclusions} />
            <Term label="Terms and conditions" value={view.termsAndConditions} />
            <Term label="Delivery timeline" value={view.deliveryTimeline} />
            <Term label="Payment terms" value={view.paymentTermName} />
          </dl>
          {view.paymentSchedule.length > 0 ? (
            <>
              <h3 className={styles.partyHeading}>Payment schedule</h3>
              <ul className={styles.schedule}>
                {view.paymentSchedule.map((m, i) => (
                  <li key={`${m.label}-${i}`}>
                    <span className={styles.schedulePercent}>{trimPercent(m.percent)}%</span>
                    <span>
                      {m.label}
                      {m.dueDescription ? (
                        <span className={styles.muted}> · {formatDay(m.dueDescription)}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      </div>

      {respond ? <aside className={styles.respond}>{respond}</aside> : null}
    </div>
  );
}

function PartyBlock({ heading, party }: { heading: string; party: Party }) {
  const a = party.address;
  const place = [a.city, a.district, a.province, a.postalCode].filter(Boolean).join(', ');
  return (
    <div className={styles.party}>
      <h3 className={styles.partyHeading}>{heading}</h3>
      <p className={styles.partyName}>{party.legalName}</p>
      <address className={styles.address}>
        {a.line1}
        {a.line2 ? (
          <>
            <br />
            {a.line2}
          </>
        ) : null}
        <br />
        {place}
        <br />
        {a.country}
      </address>
      {party.panVatNo ? <p className={styles.muted}>PAN/VAT {party.panVatNo}</p> : null}
    </div>
  );
}

function Term({ label, value }: { label: string; value: string | null }) {
  if (value === null || value.trim() === '') return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd className={styles.longText}>{value}</dd>
    </div>
  );
}
