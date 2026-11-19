import { richTextToPlain, type QuotationVersionDto } from '@bos/contracts';
import { Dec, formatCustomerDate, type CustomerDateFormat, type NumberSystems } from '@bos/locale';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { RichText } from '@/components/ui/rich-text';
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

/**
 * `2026-11-19` -> `19 Nov 2026` (or the tenant's pattern); free text (a due description such as
 * "On delivery") passes through.
 */
function dateText(value: string, dateFormat?: CustomerDateFormat): string {
  return formatCustomerDate(value, dateFormat);
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
  numberSystems,
}: {
  version: QuotationVersionDto;
  showCost: boolean;
  numberSystems?: NumberSystems | undefined;
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
              {money(line.unitPrice, currency, numberSystems)}
            </Td>
            <Td align="end" nowrap>
              {money(line.discountAlloc, currency, numberSystems)}
            </Td>
            <Td nowrap>{taxLabels.get(line.taxCodeId) ?? 'None'}</Td>
            <Td align="end" nowrap>
              {money(line.taxable, currency, numberSystems)}
            </Td>
            {showCost ? (
              <Td align="end" nowrap>
                {line.unitCost == null ? '–' : money(line.unitCost, currency, numberSystems)}
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
  numberSystems,
  dateFormat,
}: {
  version: QuotationVersionDto;
  numberSystems?: NumberSystems | undefined;
  dateFormat?: CustomerDateFormat | undefined;
}) {
  const { currency, paymentSchedule } = version;
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
              {money(milestone.amount, currency, numberSystems)}
            </Td>
            <Td>
              {milestone.dueDescription ? dateText(milestone.dueDescription, dateFormat) : '–'}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The "Contents" card of a quotation revision: what is being sold and on what terms. A server
 * component: only `LongText` is a client component. It shows what the DTO carries and computes
 * nothing: the payment amounts come from the server (D36).
 *
 * Unit cost, cost total and margin (D29) are shown only when the DTO carries them: the API leaves
 * them out for a viewer without `quotation.cost.read`, so an absent field hides its column or row.
 * A present `null` means no cost is recorded: a line shows an en dash, a total shows nothing.
 */
export function QuotationContents({
  version,
  paymentTermsName,
  today,
  numberSystems,
  dateFormat,
}: {
  version: QuotationVersionDto;
  /** The payment term's name; the DTO has only its id, so the caller resolves it. Omitted when absent. */
  paymentTermsName?: string | undefined;
  /** Today as YYYY-MM-DD in Kathmandu; defaults to the current day. */
  today?: string | undefined;
  /** How amounts are grouped (the tenant setting); omitted keeps the per-currency default. */
  numberSystems?: NumberSystems | undefined;
  /** The tenant's date pattern (`getDateFormat()`); omitted keeps `dd MMM yyyy`. */
  dateFormat?: CustomerDateFormat | undefined;
}) {
  const internalCostTotal = version.internalCostTotal ?? null;
  const marginPct = version.marginPct ?? null;
  const showCost = version.lines.some((l) => l.unitCost != null);
  const showInternalTotals = internalCostTotal !== null || marginPct !== null;
  const termsName = paymentTermsName?.trim();

  const facts: Fact[] = [
    { key: 'issue', label: 'Issue date', value: dateText(version.issueDate, dateFormat) },
    { key: 'valid', label: 'Valid until', value: dateText(version.validUntil, dateFormat) },
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
    const value = version[key];
    // The wording is rich text (D31); judge "empty" and "long" on its words, not its markup.
    const text = richTextToPlain(value);
    return value !== null && text.trim() !== '' ? [{ key, title, value, text }] : [];
  });
  const hasPayment = termsName || version.paymentSchedule.length > 0;

  return (
    <Panel title="Contents">
      <div className={styles.contents}>
        <Section title="Line items">
          <LineItems version={version} showCost={showCost} numberSystems={numberSystems} />
          {showInternalTotals ? (
            <dl className={styles.internal}>
              {internalCostTotal !== null ? (
                <div>
                  <dt>Internal cost:</dt>
                  <dd>{money(internalCostTotal, version.currency, numberSystems)}</dd>
                </div>
              ) : null}
              {marginPct !== null ? (
                <div>
                  <dt>Margin:</dt>
                  <dd>{percentText(marginPct)}</dd>
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
              <PaymentSchedule
                version={version}
                numberSystems={numberSystems}
                dateFormat={dateFormat}
              />
            ) : null}
          </Section>
        ) : null}

        {texts.map(({ key, title, value, text }) => (
          <Section key={key} title={title}>
            <LongText text={text}>
              <RichText value={value} />
            </LongText>
          </Section>
        ))}
      </div>
    </Panel>
  );
}
