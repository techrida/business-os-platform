import type { QuotationVersionDto } from '@bos/contracts';
import { Dec, allocatePaymentSchedule, formatCustomerDate, type NumberSystem } from '@bos/locale';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { money } from '@/lib/kernel-format';

import styles from './contents.module.css';
import { expiryState, isIsoCalendarDate, kathmanduToday, type ExpiryState } from './expiry';
import { LongText } from './long-text';

/** A closed quotation no longer "expires": the badge would contradict its status. */
const NO_EXPIRY_STATUSES: readonly string[] = ['accepted', 'rejected', 'cancelled', 'superseded'];

const EXPIRY_TONE = {
  valid: 'success',
  expiring: 'warning',
  expired: 'error',
} as const satisfies Record<ExpiryState, 'success' | 'warning' | 'error'>;

const TEXT_SECTIONS = [
  ['scope', 'Scope'],
  ['assumptions', 'Assumptions'],
  ['exclusions', 'Exclusions'],
  ['deliveryTimeline', 'Delivery timeline'],
  ['termsAndConditions', 'Terms and conditions'],
] as const;

/** `13` -> "13%", `33.3333` -> "33.3333%": up to four decimals, no padding zeros. */
function percentText(value: string): string {
  const n = new Dec(value);
  return n.isFinite() ? `${n.toFixed()}%` : value;
}

/** `2026-11-19` -> `19 Nov 2026`; free text (a due description such as "On delivery") passes through. */
function dateText(value: string): string {
  return formatCustomerDate(value);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </div>
  );
}

function LineItems({
  version,
  showCost,
  numberSystem,
}: {
  version: QuotationVersionDto;
  showCost: boolean;
  numberSystem?: NumberSystem | undefined;
}) {
  const { currency, lines, taxSummary } = version;
  const taxLabels = new Map(
    taxSummary.map((t) => [t.taxCodeId, `${t.label} ${percentText(t.rate)}`] as const),
  );
  if (lines.length === 0) return <p className={styles.note}>No line items.</p>;
  return (
    <Table caption="Line items" minWidth={showCost ? 900 : 760}>
      <thead>
        <tr>
          <Th>Description</Th>
          <Th align="end">Qty</Th>
          <Th align="end">Unit price</Th>
          <Th align="end">Discount</Th>
          <Th>Tax</Th>
          <Th align="end">Line total</Th>
          {showCost ? <Th align="end">Unit cost</Th> : null}
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.lineNo}>
            <Td>
              <span className={styles.lineNo}>{line.lineNo}. </span>
              {line.description}
            </Td>
            <Td align="end" nowrap>
              {line.quantity} <span className={styles.uom}>{line.uom}</span>
            </Td>
            <Td align="end" nowrap>
              {money(line.unitPrice, currency, numberSystem)}
            </Td>
            <Td align="end" nowrap>
              {money(line.discountAlloc, currency, numberSystem)}
            </Td>
            <Td nowrap>{taxLabels.get(line.taxCodeId) ?? 'None'}</Td>
            <Td align="end" nowrap>
              {money(line.taxable, currency, numberSystem)}
            </Td>
            {showCost ? (
              <Td align="end" nowrap>
                {line.unitCost === null ? '–' : money(line.unitCost, currency, numberSystem)}
              </Td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function PaymentSchedule({
  version,
  numberSystem,
}: {
  version: QuotationVersionDto;
  numberSystem?: NumberSystem | undefined;
}) {
  const { currency, paymentSchedule, totals } = version;
  const amounts = allocatePaymentSchedule(
    new Dec(totals.total),
    paymentSchedule.map((m) => m.percent),
  );
  return (
    <Table caption="Payment schedule" minWidth={560}>
      <thead>
        <tr>
          <Th>Milestone</Th>
          <Th align="end">Share</Th>
          <Th align="end">Amount</Th>
          <Th>Due</Th>
        </tr>
      </thead>
      <tbody>
        {paymentSchedule.map((milestone, index) => (
          <tr key={`${index}-${milestone.label}`}>
            <Td>{milestone.label}</Td>
            <Td align="end" nowrap>
              {percentText(milestone.percent)}
            </Td>
            <Td align="end" nowrap>
              {money(amounts[index]!.toFixed(2), currency, numberSystem)}
            </Td>
            <Td>{milestone.dueDescription ? dateText(milestone.dueDescription) : '–'}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The "Contents" card of a quotation revision: what is being sold and on what terms. A server
 * component: only `LongText` is a client component. It shows what the DTO carries and computes
 * nothing but the payment amounts, which D22 derives from the total (2 decimals half-up, the
 * remainder on the last row).
 *
 * `internalVisible` is decided by the caller from the viewer's roles; with `false` the unit cost
 * column and the internal totals are not rendered. The caller should also strip the figures from
 * the data (`withoutInternalFigures`), so they never reach the page at all.
 */
export function QuotationContents({
  version,
  internalVisible,
  paymentTermsName,
  today,
  numberSystem,
}: {
  version: QuotationVersionDto;
  internalVisible: boolean;
  /** The payment term's name; the DTO has only its id, so the caller resolves it. Omitted when absent. */
  paymentTermsName?: string | undefined;
  /** Today as YYYY-MM-DD in Kathmandu; defaults to the current day. */
  today?: string | undefined;
  /** How amounts are grouped (the tenant setting); omitted keeps the per-currency default. */
  numberSystem?: NumberSystem | undefined;
}) {
  const showCost = internalVisible && version.lines.some((l) => l.unitCost !== null);
  const showInternalTotals =
    internalVisible && (version.internalCostTotal !== null || version.marginPct !== null);
  const termsName = paymentTermsName?.trim();

  const facts: Fact[] = [
    { key: 'issue', label: 'Issue date', value: dateText(version.issueDate) },
    { key: 'valid', label: 'Valid until', value: dateText(version.validUntil) },
  ];
  if (!NO_EXPIRY_STATUSES.includes(version.status) && isIsoCalendarDate(version.validUntil)) {
    const expiry = expiryState(version.validUntil, today ?? kathmanduToday());
    facts.push({
      key: 'expiry',
      label: 'Expiry',
      value: (
        <Badge tone={EXPIRY_TONE[expiry.state]} className={styles.expiry}>
          {expiry.label}
        </Badge>
      ),
    });
  }

  const texts = TEXT_SECTIONS.flatMap(([key, title]) => {
    const text = version[key];
    return text !== null && text.trim() !== '' ? [{ key, title, text }] : [];
  });
  const hasPayment = termsName || version.paymentSchedule.length > 0;

  return (
    <Panel title="Contents">
      <div className={styles.contents}>
        <Section title="Line items">
          <LineItems version={version} showCost={showCost} numberSystem={numberSystem} />
          {showInternalTotals ? (
            <dl className={styles.internal}>
              {version.internalCostTotal !== null ? (
                <div>
                  <dt>Internal cost:</dt>
                  <dd>{money(version.internalCostTotal, version.currency, numberSystem)}</dd>
                </div>
              ) : null}
              {version.marginPct !== null ? (
                <div>
                  <dt>Margin:</dt>
                  <dd>{percentText(version.marginPct)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </Section>

        <Section title="Validity">
          <FactList facts={facts} />
        </Section>

        {hasPayment ? (
          <Section title="Payment">
            {termsName ? (
              <FactList facts={[{ key: 'terms', label: 'Payment terms', value: termsName }]} />
            ) : null}
            {version.paymentSchedule.length > 0 ? (
              <PaymentSchedule version={version} numberSystem={numberSystem} />
            ) : null}
          </Section>
        ) : null}

        {texts.map(({ key, title, text }) => (
          <Section key={key} title={title}>
            <LongText text={text} />
          </Section>
        ))}
      </div>
    </Panel>
  );
}
