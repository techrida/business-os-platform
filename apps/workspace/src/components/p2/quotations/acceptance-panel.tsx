import { randomUUID } from 'node:crypto';

import type { CustomerDateFormat } from '@bos/locale';
import type { QuotationVersionDto, SalesOrderListItem } from '@bos/contracts';
import Link from 'next/link';

import { salesOrderStatusMeta } from '@/app/(app)/sales-orders/_lib/status';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { when } from '@/lib/kernel-format';

import { ConfirmAcceptanceDialog } from './confirm-acceptance-dialog';
import styles from './detail.module.css';
import type { AcceptanceConfirmation } from './lifecycle-contract';

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
  confirmation,
  confirmedByName,
  mayConfirm,
  order,
  mayReadOrders,
  reloadHref,
  dateFormat,
}: {
  quotationId: string;
  number: string;
  /** The accepted current revision. */
  version: QuotationVersionDto;
  /** Undefined when the platform sent no confirmation state for this revision. */
  confirmation: AcceptanceConfirmation | null | undefined;
  confirmedByName?: string | undefined;
  mayConfirm: boolean;
  /** The revision's sales order that is not cancelled, if any. */
  order: SalesOrderListItem | undefined;
  mayReadOrders: boolean;
  reloadHref: string;
  dateFormat?: CustomerDateFormat | undefined;
}) {
  const facts: Fact[] = [];
  const awaiting = confirmation != null && confirmation.status === 'awaiting';

  if (confirmation != null) {
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
            A staff member checks the signed copy or purchase order.
          </span>
        </span>
      ) : (
        <span className={styles.stateLine}>
          <Badge tone="success">
            <Icon name="check-circle" size={12} />
            Confirmed
          </Badge>
          {confirmedByName || confirmation.confirmedAt ? (
            <span className={styles.recordNote}>
              {[
                confirmedByName ? `by ${confirmedByName}` : null,
                confirmation.confirmedAt
                  ? `on ${when(confirmation.confirmedAt, 'date', dateFormat)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' ')}
            </span>
          ) : null}
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
        awaiting && mayConfirm ? (
          <ConfirmAcceptanceDialog
            quotationId={quotationId}
            versionId={version.id}
            version={version.version}
            number={number}
            revisionNo={version.revisionNo}
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
