import { trimPercent } from '@bos/contracts';
import type { ApprovalRequestDto } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FactList, type Fact } from '@/components/ui/panel';
import { money, snapshotEntries } from '@/lib/kernel-format';

import styles from './approval-summary.module.css';
import { discountNeedsApproval, parseApprovalSnapshot, routeReasons } from './approval-snapshot';

/** What the summary needs of an approval request: the frozen snapshot and the route's steps. */
type SummaryRequest = Pick<ApprovalRequestDto, 'snapshot'> & {
  steps: readonly { seq: number; reason: string }[];
};

/** The stored values as they are, for a snapshot that is not a quotation snapshot. */
function StoredValues({
  snapshot,
  numberSystems,
}: {
  snapshot: unknown;
  numberSystems: NumberSystems | undefined;
}) {
  const facts: Fact[] = snapshotEntries(snapshot, undefined, numberSystems).map((row) => ({
    key: row.key,
    label: row.label,
    value: row.block ? <pre className={styles.pre}>{row.value}</pre> : row.value,
    wide: row.block,
  }));
  return facts.length === 0 ? (
    <p className={styles.note}>The snapshot is empty.</p>
  ) : (
    <FactList facts={facts} />
  );
}

/**
 * The "What was submitted" content for a quotation version, read from the frozen snapshot the
 * approvers saw. It never fetches the live version and never computes a figure: every number is
 * a stored string, formatted for display only. A snapshot that does not parse shows "Not in this
 * snapshot" and the stored values as they are.
 */
export function QuotationApprovalSummary({
  request,
  numberSystems,
}: {
  request: SummaryRequest;
  /** The tenant's grouping setting; left out, each currency keeps its own grouping. */
  numberSystems?: NumberSystems;
}) {
  const snap = parseApprovalSnapshot(request.snapshot);

  if (snap === null) {
    return (
      <div className={styles.summary}>
        <Alert tone="info" title="Not in this snapshot">
          The quotation summary could not be read from this request, so the stored values are shown
          as they are.
        </Alert>
        <StoredValues snapshot={request.snapshot} numberSystems={numberSystems} />
      </div>
    );
  }

  const reasons = routeReasons(request.steps);
  const over = discountNeedsApproval(snap);
  const foreign = snap.currency !== 'NPR';

  const facts: Fact[] = [
    {
      key: 'total',
      label: 'Total (NPR)',
      value: (
        <span className={`${styles.figure} ${styles.total}`}>
          {money(snap.nprTotal, 'NPR', numberSystems)}
        </span>
      ),
    },
    {
      key: 'discount',
      label: 'Discount',
      value: (
        <span className={styles.figure}>{money(snap.nprDiscountAmount, 'NPR', numberSystems)}</span>
      ),
    },
    {
      key: 'discountPct',
      label: 'Effective discount',
      value: over ? (
        <span className={`${styles.figure} ${styles.over}`}>
          {trimPercent(snap.effectiveDiscountPct)}%<Badge tone="warning">Above the 12% limit</Badge>
        </span>
      ) : (
        <span className={styles.figure}>{trimPercent(snap.effectiveDiscountPct)}%</span>
      ),
    },
  ];
  // Absent: the viewer lacks `quotation.cost.read` (D29), so the row is not shown at all. Null: no cost is recorded.
  if (snap.marginPct !== undefined) {
    facts.push({
      key: 'margin',
      label: 'Margin',
      value:
        snap.marginPct === null ? (
          <span className={styles.quiet}>Not recorded</span>
        ) : (
          <span className={styles.figure}>{trimPercent(snap.marginPct)}%</span>
        ),
    });
  }
  if (foreign) {
    facts.push(
      { key: 'currency', label: 'Document currency', value: snap.currency },
      {
        key: 'fx',
        label: 'Exchange rate',
        value: (
          <span className={styles.figure}>
            1 {snap.currency} = NPR {trimPercent(snap.fxRate)}
          </span>
        ),
      },
    );
  }

  return (
    <div className={styles.summary}>
      <div className={styles.identity}>
        <p className={styles.number}>
          <span>{snap.quotationNumber}</span>
          <span className={styles.revision}>Rev {snap.revisionNo}</span>
        </p>
        <p className={styles.customer}>{snap.customerName}</p>
      </div>

      <FactList facts={facts} />

      {reasons.length > 0 ? (
        <div>
          <h3 className={styles.reasonsHead}>Why it needs these approvers</h3>
          <ul className={styles.reasons}>
            {reasons.map((reason) => (
              <li key={reason} className={styles.reason}>
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
