import { randomUUID } from 'node:crypto';

import type { CustomerDateFormat } from '@bos/locale';
import type { QuotationVersionDto, SalesOrderListItem } from '@bos/contracts';
import Link from 'next/link';

import { salesOrderStatusMeta } from '@/app/(app)/sales-orders/_lib/status';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { when } from '@/lib/kernel-format';

import { ConfirmEvidenceDialog } from './confirm-evidence-dialog';
import styles from './detail.module.css';
import { EVIDENCE_LABELS } from './eligibility';
import { policyKinds, type QuotationEvidence } from './lifecycle-contract';

/**
 * What follows a customer's acceptance, on the accepted revision: the staff check of the customer's
 * evidence (F1-Q28) and the sales order drafted from it for Accounts to confirm (F1-Q25). Server
 * Component. Each row appears only when there is something true to say: no confirmation row when
 * the platform has no such step for this revision, no order row for a person who may not read orders.
 */
export function AcceptancePanel({
  quotationId,
  number,
  version,
  evidence,
  confirmedByName,
  order,
  mayReadOrders,
  reloadHref,
  dateFormat,
}: {
  quotationId: string;
  number: string;
  /** The accepted current revision. */
  version: QuotationVersionDto;
  /** Where the acceptance evidence stands; null when the platform has none to show. */
  evidence: QuotationEvidence | null | undefined;
  /** The name of whoever confirmed it, when the quotation names them. */
  confirmedByName?: string | undefined;
  /** The revision's sales order that is not cancelled, if any. */
  order: SalesOrderListItem | undefined;
  mayReadOrders: boolean;
  reloadHref: string;
  dateFormat?: CustomerDateFormat | undefined;
}) {
  const facts: Fact[] = [];
  const awaiting = evidence?.status === 'pending';
  const wanted = evidence ? policyKinds(evidence.policy) : [];
  const policyText =
    wanted.length > 0
      ? wanted.map((k) => `a ${EVIDENCE_LABELS[k].toLowerCase()}`).join(' and ')
      : undefined;
  const confirmation = evidence?.confirmation ?? null;

  if (evidence) {
    facts.push({
      key: 'evidence',
      label: 'Customer evidence',
      value: awaiting ? (
        <span className={styles.stateLine}>
          <Badge tone="warning">
            <Icon name="shield-check" size={12} />
            Awaiting confirmation
          </Badge>
          <span className={styles.recordNote}>
            {policyText
              ? `Accepted in the portal. A staff member confirms ${policyText} before the sales order.`
              : 'Accepted in the portal. A staff member confirms the evidence before the sales order.'}
          </span>
        </span>
      ) : (
        <span className={styles.stateLine}>
          <Badge tone="success">
            <Icon name="check-circle" size={12} />
            Confirmed
          </Badge>
          <span className={styles.recordNote}>
            {confirmation
              ? [
                  confirmation.evidenceKinds.map((k) => EVIDENCE_LABELS[k]).join(', '),
                  confirmedByName ? `by ${confirmedByName}` : null,
                  `on ${when(confirmation.confirmedAt, 'date', dateFormat)}`,
                ]
                  .filter(Boolean)
                  .join(' ')
              : 'Checked when the acceptance was recorded.'}
          </span>
        </span>
      ),
      wide: true,
    });
  }

  if (mayReadOrders) {
    const meta = order ? salesOrderStatusMeta(order.status) : null;
    facts.push({
      key: 'order',
      label: 'Sales order',
      value:
        order && meta ? (
          <span className={styles.stateLine}>
            <Link href={`/sales-orders/${encodeURIComponent(order.id)}`}>
              {order.number ?? 'Draft sales order'}
            </Link>
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {order.status === 'draft' ? (
              <span className={styles.recordNote}>Accounts confirms it before billing starts.</span>
            ) : null}
          </span>
        ) : (
          <span className={styles.quiet}>Not created yet</span>
        ),
      wide: true,
    });
  }

  if (facts.length === 0) return null;

  return (
    <Panel
      title="After acceptance"
      className={styles.detailPanel}
      actions={
        awaiting && evidence.can.confirm ? (
          <ConfirmEvidenceDialog
            key={`${version.id}:${version.version}`}
            quotationId={quotationId}
            versionId={version.id}
            number={number}
            revisionNo={version.revisionNo}
            policyText={policyText}
            initialKinds={evidence.acceptance.evidenceKinds}
            idempotencyKey={randomUUID()}
            reloadHref={reloadHref}
          />
        ) : null
      }
    >
      <FactList facts={facts} />
    </Panel>
  );
}
