'use client';

import { useActionState, useRef } from 'react';

import { PendingLine, useFocusOnProblem } from '@/components/p2/quotations/action-dialog';
import { Button } from '@/components/ui/button';

import { draftInvoiceAction } from '../_lib/actions';
import type { ActionState } from '../_lib/state';

import { ErrorSummary } from './error-summary';
import styles from './sales-orders.module.css';

export interface DraftInvoiceFormProps {
  salesOrderId: string;
  scheduleLineId: string;
  /** The step's name, so the button has a name of its own when a table holds several. */
  lineLabel: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Draft invoice for one billable step. A click starts the draft and opens it (or, for someone who may
 * not open invoices, returns to the order). When the step already has a draft (somebody else was
 * first) the refusal says so and links to that invoice only when the person may open it.
 */
export function DraftInvoiceForm({
  salesOrderId,
  scheduleLineId,
  lineLabel,
  idempotencyKey,
  reloadHref,
}: DraftInvoiceFormProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(draftInvoiceAction, {
    key: idempotencyKey,
  });
  const wrapRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);

  return (
    <form noValidate action={formAction} ref={wrapRef} className={styles.inlineForm}>
      <input type="hidden" name="salesOrderId" value={salesOrderId} />
      <input type="hidden" name="scheduleLineId" value={scheduleLineId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />

      <ErrorSummary
        error={state.error}
        reload={state.reload}
        reloadHref={reloadHref}
        link={
          state.takenInvoiceId !== undefined
            ? {
                href: `/invoices/${encodeURIComponent(state.takenInvoiceId)}`,
                label: 'Open that invoice',
              }
            : undefined
        }
        summaryRef={summaryRef}
      />

      <Button
        type="submit"
        size="small"
        disabled={pending}
        aria-label={`Draft invoice for ${lineLabel}`}
      >
        Draft invoice
      </Button>
      <PendingLine pending={pending} words="Drafting the invoice" />
    </form>
  );
}
