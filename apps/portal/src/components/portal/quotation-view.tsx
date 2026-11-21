import { trimPercent, type CustomerQuotationView } from '@bos/contracts';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ViewDocument } from '@/components/ui/document-viewer';
import { displayFormat, taxLineLabel } from '@/lib/display';

import { PdfNotReady } from './pdf-not-ready';
import styles from './quotation.module.css';
import { RichText } from './rich-text';
import { displayStatus, STATUS_LOOK } from './quotation-status';

type View = CustomerQuotationView;
type Party = View['issuer'];

/**
 * One quotation as the customer sees it. It reads only `CustomerQuotationView`, a strict whitelist
 * with no cost, margin, FX or approval data, so nothing internal can reach this markup. A test
 * renders it and scans the words. Amounts and dates use `view.display`, the setting this version
 * was sent with. `respond` is the accept/reject panel the page puts beside it.
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
  const { money: formatAmount, day: formatDay } = displayFormat(view.display);
  const money = (amount: string) => formatAmount(amount, view.currency);
  const hasTerms = [
    view.scope,
    view.assumptions,
    view.exclusions,
    view.termsAndConditions,
    view.deliveryTimeline,
    view.paymentTermName,
  ].some((value) => typeof value === 'string' && value.trim() !== '');
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
              {/* Opens the in-page viewer. The Download link beside it is a plain anchor: the target is a
                  route handler, and a prefetch would fetch the PDF. No `download` attribute: the API sends
                  attachment, and an error must read as text. */}
              <ViewDocument
                name={view.file.filename}
                previewUrl={`/quotations/${view.id}/document/preview`}
                downloadUrl={`/quotations/${view.id}/document`}
                variant="secondary"
                size="small"
                withDownload
              />
              <p className={styles.checksum}>
                {view.file.filename}
                <span className={styles.visuallyHidden}>, </span>
                <span>
                  SHA-256 <code className={styles.hash}>{view.file.sha256}</code>
                </span>
              </p>
            </div>
          ) : (
            <PdfNotReady failed={view.renderFailed === true} className={styles.muted} />
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
                <dt>{taxLineLabel(t.label, t.percent)}</dt>
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

        {hasTerms || view.paymentSchedule.length > 0 ? (
          <Card
            as="section"
            {...(hasTerms
              ? { 'aria-labelledby': 'terms-h' }
              : { 'aria-label': 'Payment schedule' })}
            className={styles.section}
          >
            {hasTerms ? (
              <>
                <h2 id="terms-h" className={styles.sectionTitle}>
                  Terms
                </h2>
                <dl className={styles.terms}>
                  <Term label="Scope" value={view.scope} rich />
                  <Term label="Assumptions" value={view.assumptions} rich />
                  <Term label="Exclusions" value={view.exclusions} rich />
                  <Term label="Terms and conditions" value={view.termsAndConditions} rich />
                  <Term label="Delivery timeline" value={view.deliveryTimeline} rich />
                  <Term label="Payment terms" value={view.paymentTermName} />
                </dl>
              </>
            ) : null}
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
                      {/* The amount is the server's split of the total (D36); the portal never recomputes it. */}
                      <span className={styles.scheduleAmount}>{money(m.amount)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Card>
        ) : null}
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

function Term({ label, value, rich }: { label: string; value: string | null; rich?: boolean }) {
  if (value === null || value.trim() === '') return null;
  return (
    <div>
      <dt>{label}</dt>
      {rich ? (
        <dd>
          <RichText value={value} />
        </dd>
      ) : (
        <dd className={styles.longText}>{value}</dd>
      )}
    </div>
  );
}
