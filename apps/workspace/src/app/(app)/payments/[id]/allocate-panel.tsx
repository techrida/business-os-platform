'use client';

import type { InvoiceSettlement, PaymentDto } from '@bos/contracts';
import Link from 'next/link';
import { useActionState, useMemo, useRef, useState } from 'react';

import { PendingLine, useFocusOnProblem } from '@/components/p2/quotations/action-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { MoneyInput } from '@/components/ui/number-input';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { Panel, FactList } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { money, when } from '@/lib/kernel-format';

import { allocateAction, type AllocateState } from './allocate-actions';
import styles from './allocate.module.css';

export interface AllocatePanelProps {
  paymentId: string;
  currency: PaymentDto['currency'];
  /** What this payment has left to allocate, as the server states it. */
  remaining: string;
  /** The customer's unallocated credit in this currency from the server; null when it could not be read. */
  advance: string | null;
  /** The customer's open invoices and debit notes in this currency; null when they could not be read. */
  items: readonly InvoiceSettlement[] | null;
  /** One UUID for this render's first allocation, generated on the server. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Spreads a verified payment over the customer's open invoices. The person types an amount per
 * invoice; nothing here adds amounts up or checks them against what is open or left. The server
 * refuses too much or the wrong invoice (OVER_ALLOCATION, MISMATCHED_ITEMS) and its words are shown
 * above the table. Whether the person may allocate at all is decided by the page, which mounts this
 * panel only for a verified payment and a role with `payment.allocate`; the API still decides.
 */
export function AllocatePanel({
  paymentId,
  currency,
  remaining,
  advance,
  items,
  idempotencyKey,
  reloadHref,
}: AllocatePanelProps) {
  const numberSystems = useNumberSystems();
  return (
    <Panel
      title="Allocate this payment"
      description="Choose how much of this payment settles each open invoice. The platform checks the amounts when you allocate."
    >
      <div className={styles.allocate}>
        <FactList
          facts={[
            {
              key: 'left',
              label: 'Left on this payment',
              value: money(remaining, currency, numberSystems),
            },
            {
              key: 'advance',
              label: `Customer advance in ${currency}`,
              value:
                advance === null ? 'Could not be loaded' : money(advance, currency, numberSystems),
            },
          ]}
        />
        {items === null ? (
          <Alert
            tone="warning"
            role="status"
            actions={<a href={reloadHref}>Reload this payment</a>}
          >
            The open invoices could not be loaded. Reload the page to try again.
          </Alert>
        ) : items.length === 0 ? (
          <p className={styles.quiet}>
            This customer has no open invoices in {currency}, so there is nothing to allocate this
            payment to yet.
          </p>
        ) : (
          <AllocateForm
            paymentId={paymentId}
            currency={currency}
            items={items}
            idempotencyKey={idempotencyKey}
            reloadHref={reloadHref}
          />
        )}
      </div>
    </Panel>
  );
}

function AllocateForm({
  paymentId,
  currency,
  items,
  idempotencyKey,
  reloadHref,
}: Pick<AllocatePanelProps, 'paymentId' | 'currency' | 'idempotencyKey' | 'reloadHref'> & {
  items: readonly InvoiceSettlement[];
}) {
  const numberSystems = useNumberSystems();
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe what the
  // person typed when the API refuses. Cleared once an allocation is accepted.
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [state, formAction, pending] = useActionState<AllocateState, FormData>(
    async (prev, form) => {
      const next = await allocateAction(prev, form);
      if (next.done === true) {
        setAmounts({});
        toast.success('Payment allocated');
      }
      return next;
    },
    { key: idempotencyKey },
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const problem = useMemo(
    () => ({ error: state.error ?? state.errors?.form, errors: state.errors?.lines }),
    [state],
  );
  useFocusOnProblem(problem, wrapRef, summaryRef);

  return (
    <div ref={wrapRef}>
      <form action={formAction} className={styles.form}>
        <input type="hidden" name="paymentId" value={paymentId} />
        <input type="hidden" name="idempotencyKey" value={state.key} />
        {problem.error ? (
          <Alert
            ref={summaryRef}
            tabIndex={-1}
            tone="error"
            role="alert"
            actions={state.reload ? <a href={reloadHref}>Reload this payment</a> : null}
          >
            {problem.error}
          </Alert>
        ) : null}
        <Table caption="Open invoices to allocate this payment to" minWidth={600}>
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th>Due</Th>
              <Th align="end">Open amount</Th>
              <Th className={styles.amountCol}>Amount to allocate</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const rowError = state.errors?.lines?.[item.invoiceId];
              // Ends in -error so MoneyInput reads it after the currency, as it does for Field errors.
              const errorId = `amount-${item.invoiceId}-error`;
              return (
                <tr key={item.invoiceId}>
                  <Td>
                    <Link
                      href={`/invoices/${encodeURIComponent(item.invoiceId)}`}
                      className={styles.wrap}
                    >
                      {item.number}
                    </Link>
                  </Td>
                  <Td>
                    {item.dueDate !== null ? when(item.dueDate, 'date') : 'No due date'}
                    {item.daysOverdue > 0 ? (
                      <>
                        {' '}
                        <span className={styles.overdue}>
                          · {item.daysOverdue} {item.daysOverdue === 1 ? 'day' : 'days'} overdue
                        </span>
                      </>
                    ) : null}
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.openAmount}>
                      {money(item.openAmount, currency, numberSystems)}
                    </span>
                  </Td>
                  <Td>
                    <MoneyInput
                      name={`amount:${item.invoiceId}`}
                      currency={currency}
                      min="0.01"
                      value={amounts[item.invoiceId] ?? ''}
                      onValueChange={(value) => {
                        setAmounts((prev) => ({ ...prev, [item.invoiceId]: value }));
                      }}
                      placeholder="0.00"
                      aria-label={`Amount to allocate to ${item.number}`}
                      aria-invalid={rowError ? true : undefined}
                      aria-describedby={rowError ? errorId : undefined}
                    />
                    {rowError ? (
                      <span id={errorId} className={styles.rowError}>
                        {rowError}
                      </span>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <div className={styles.buttons}>
          <Button type="submit" disabled={pending}>
            Allocate payment
          </Button>
        </div>
        <PendingLine pending={pending} words="Allocating the payment" />
      </form>
    </div>
  );
}
