'use client';

import type { SalesOrderDetail } from '@bos/contracts';
import { useState } from 'react';

import { TransactionFormDialog } from '@/components/p3/transaction-form-dialog';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';

import local from '../_components/sales-orders.module.css';
import { releaseDeliveryAction, type ReleaseDeliveryState } from './release-delivery-action';
import { releaseBlockedText, SOLE_ELIGIBLE_HINT, whoCanRelease } from './release-delivery-text';

export interface ReleaseDeliveryProps {
  salesOrderId: string;
  /** The order's `can`, from the caller's live grants and the live threshold. */
  can: SalesOrderDetail['can'];
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Release a confirmed order's held delivery before its advance is paid (F1-Q32). Offered only when the API says
 * the caller would pass the rule; otherwise the button stays visible but off, with the reason beside it.
 */
export function ReleaseDelivery({
  salesOrderId,
  can,
  idempotencyKey,
  reloadHref,
}: ReleaseDeliveryProps) {
  const [reason, setReason] = useState('');
  if (can?.releaseDelivery !== true) {
    return (
      <span className={local.release}>
        <Button variant="secondary" disabled>
          Release delivery
        </Button>
        <span className={local.meta}>
          {releaseBlockedText(can?.releaseDeliveryBlockedBy, can?.releaseDeliveryAllowedRoles)}
        </span>
      </span>
    );
  }
  // The small-team rule (F1-Q11 a): the Founder who created the order is the only one who may release it.
  const soleEligible = can.releaseSoleEligible === true;
  return (
    <TransactionFormDialog<ReleaseDeliveryState>
      trigger="Release delivery"
      title="Release this delivery?"
      description={`The delivery can go ahead before the advance is paid. ${whoCanRelease(can.releaseDeliveryAllowedRoles, soleEligible)} A release is final, and the reason is kept on the order.`}
      submit="Release delivery"
      successMessage="Delivery released"
      initial={{ key: idempotencyKey }}
      action={releaseDeliveryAction}
      reloadHref={reloadHref}
      focusHeadingOnDone
    >
      {(state) => (
        <>
          <input type="hidden" name="salesOrderId" value={salesOrderId} />
          <Field
            label="Reason"
            hint={
              soleEligible
                ? `Why the delivery should go ahead now. ${SOLE_ELIGIBLE_HINT}`
                : 'Why the delivery should go ahead now.'
            }
            error={state.errors?.reason}
          >
            {(control) => (
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                maxLength={1000}
                required
                {...control}
              />
            )}
          </Field>
        </>
      )}
    </TransactionFormDialog>
  );
}
