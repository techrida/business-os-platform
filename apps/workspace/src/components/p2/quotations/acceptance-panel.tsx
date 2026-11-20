import { randomUUID } from 'node:crypto';

import type { CustomerDateFormat } from '@bos/locale';
import type { QuotationVersionDto } from '@bos/contracts';

import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { when } from '@/lib/kernel-format';

import { ConfirmAcceptanceDialog } from './confirm-acceptance-dialog';
import styles from './detail.module.css';
import type { AcceptanceConfirmation } from './lifecycle-contract';

/**
 * What follows a customer's acceptance, on the accepted revision: the staff check of the customer's
 * evidence (F1-Q28). Server Component. The row appears only when the platform sent a confirmation
 * state for this revision.
 */
export function AcceptancePanel({
  quotationId,
  number,
  version,
  confirmation,
  confirmedByName,
  mayConfirm,
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
