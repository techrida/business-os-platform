'use client';

import Link from 'next/link';
import { useActionState, useId, useRef, useState } from 'react';

import {
  ActionDialog,
  PendingLine,
  useFocusOnProblem,
} from '@/components/p2/quotations/action-dialog';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { Panel } from '@/components/ui/panel';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import type { PaymentRequestItem } from '@/lib/api-payables';
import { money } from '@/lib/kernel-format';

import type { ActionState } from '../../procurement/orders/_lib/state';
import styles from '../payables.module.css';
import {
  cancelPaymentRequestAction,
  createPaymentRequestAction,
  submitPaymentRequestAction,
} from './actions';

export function PaymentRequestEntry({
  idempotencyKey,
  items,
}: {
  idempotencyKey: string;
  items: PaymentRequestItem[];
}) {
  const numberSystems = useNumberSystems();
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createPaymentRequestAction,
    { key: idempotencyKey },
  );
  const [header, setHeader] = useState({
    vendorPartyId: '',
    fromBankAccountId: '',
    purchaseOrderId: '',
    currency: 'NPR',
  });
  const [rows, setRows] = useState([{ openItemId: '', amount: '' }]);
  const wrap = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrap, summary);
  const errors = state.errors ?? {};
  const vendors = [
    ...new Map(items.map((item) => [item.vendorPartyId, item.vendorName])).entries(),
  ];
  const currencies = [
    ...new Set(
      items
        .filter((item) => item.vendorPartyId === header.vendorPartyId)
        .map((item) => item.currency),
    ),
  ];
  const eligible = items.filter(
    (item) => item.vendorPartyId === header.vendorPartyId && item.currency === header.currency,
  );
  return (
    <div ref={wrap}>
      <form action={action} noValidate className={styles.form}>
        <input type="hidden" name="idempotencyKey" value={state.key} />
        <input type="hidden" name="lineCount" value={rows.length} />
        {state.error ? (
          <Alert
            ref={summary}
            tabIndex={-1}
            role="alert"
            tone="error"
            actions={
              state.reload ? (
                <Link href="/payables/payment-requests/new">Reload this page</Link>
              ) : null
            }
          >
            {state.error}
          </Alert>
        ) : null}
        <Panel title="Request details">
          <div className={styles.lineFields}>
            <Field label="Vendor" error={errors['vendorPartyId']}>
              {(control) => (
                <Select
                  name="vendorPartyId"
                  value={header.vendorPartyId}
                  onChange={(e) => {
                    const vendorPartyId = e.target.value;
                    setHeader((current) => ({
                      ...current,
                      vendorPartyId,
                      currency:
                        items.find((item) => item.vendorPartyId === vendorPartyId)?.currency ??
                        'NPR',
                    }));
                    setRows([{ openItemId: '', amount: '' }]);
                  }}
                  {...control}
                >
                  <option value="">Choose a vendor</option>
                  {vendors.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {(
              [
                ['fromBankAccountId', 'Paying entity bank account ID'],
                ['purchaseOrderId', 'Purchase order ID (optional)'],
              ] as const
            ).map(([name, label]) => (
              <Field key={name} label={label} error={errors[name]}>
                {(control) => (
                  <Input
                    name={name}
                    value={header[name]}
                    onChange={(e) =>
                      setHeader((current) => ({ ...current, [name]: e.target.value }))
                    }
                    autoComplete="off"
                    spellCheck={false}
                    {...control}
                  />
                )}
              </Field>
            ))}
            <Field label="Currency" error={errors['currency']}>
              {(control) => (
                <Select
                  name="currency"
                  value={header.currency}
                  onChange={(e) => {
                    setHeader((current) => ({ ...current, currency: e.target.value }));
                    setRows([{ openItemId: '', amount: '' }]);
                  }}
                  disabled={header.vendorPartyId === ''}
                  {...control}
                >
                  {currencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Panel>
        <Panel title="Payable items">
          <p className={styles.note}>
            Request settlement of this vendor&apos;s approved bills. The platform checks each open
            item and snapshots the vendor&apos;s active, verified bank account. Available amounts
            exclude claims by pending and approved requests and are checked again when you save.
          </p>
          {rows.map((row, i) => (
            <fieldset key={i} className={styles.lineGroup}>
              <legend>Payable item {i + 1}</legend>
              <div className={styles.lineFields}>
                <Field label={`Bill ${i + 1}`} error={errors[`allocations.${i}.openItemId`]}>
                  {(control) => (
                    <Select
                      name={`allocation:${i}:openItemId`}
                      value={row.openItemId}
                      onChange={(e) =>
                        setRows((current) =>
                          current.map((line, index) =>
                            index === i ? { ...line, openItemId: e.target.value } : line,
                          ),
                        )
                      }
                      disabled={header.vendorPartyId === ''}
                      {...control}
                    >
                      <option value="">Choose an approved bill</option>
                      {eligible.map((item) => (
                        <option key={item.openItemId} value={item.openItemId}>
                          {item.billNumber ?? item.vendorInvoiceNo} · {item.vendorInvoiceNo} ·{' '}
                          {money(item.availableAmount, item.currency, numberSystems)} available
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={`Amount ${i + 1}`} error={errors[`allocations.${i}.amount`]}>
                  {(control) => (
                    <Input
                      name={`allocation:${i}:amount`}
                      value={row.amount}
                      inputMode="decimal"
                      onChange={(e) =>
                        setRows((current) =>
                          current.map((line, index) =>
                            index === i ? { ...line, amount: e.target.value } : line,
                          ),
                        )
                      }
                      {...control}
                    />
                  )}
                </Field>
              </div>
              {rows.length > 1 ? (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setRows((current) => current.filter((_, index) => index !== i))}
                  >
                    Remove item {i + 1}
                  </Button>
                </div>
              ) : null}
            </fieldset>
          ))}
          {rows.length < 200 ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setRows((current) => [...current, { openItemId: '', amount: '' }])}
              >
                Add a payable item
              </Button>
            </div>
          ) : null}
        </Panel>
        <div className={styles.entryActions}>
          <Button type="submit" disabled={pending || eligible.length === 0}>
            Create draft request
          </Button>
          <LinkButton href="/payables/payment-requests" variant="secondary">
            Cancel
          </LinkButton>
        </div>
        <PendingLine pending={pending} words="Creating the payment request" />
      </form>
    </div>
  );
}

export function PaymentRequestCommand({
  id,
  idempotencyKey,
  operation,
}: {
  id: string;
  idempotencyKey: string;
  operation: 'submit' | 'cancel';
}) {
  const cancel = operation === 'cancel';
  const [state, action, pending] = useActionState<ActionState, FormData>(
    cancel ? cancelPaymentRequestAction : submitPaymentRequestAction,
    { key: idempotencyKey },
  );
  const [reason, setReason] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrap, summary);
  const formId = useId();
  const label = cancel ? 'Cancel draft' : 'Submit for approval';
  return (
    <ActionDialog
      formId={formId}
      pending={pending}
      done={state.done !== undefined}
      submitLabel={label}
      triggerLabel={label}
      title={label}
      intro={
        cancel
          ? 'Cancel this draft and keep its reason in the audit trail.'
          : 'Send this request to its approvers. The requester, bill enterers and bill approvers cannot approve it. Approval does not send money.'
      }
    >
      <div ref={wrap}>
        {state.done ? (
          <p role="status">{state.done}</p>
        ) : (
          <form id={formId} action={action} className={styles.form}>
            <input type="hidden" name="requestId" value={id} />
            <input type="hidden" name="idempotencyKey" value={state.key} />
            {state.error ? (
              <Alert
                ref={summary}
                tabIndex={-1}
                tone="error"
                role="alert"
                actions={
                  state.reload ? (
                    <a href={`/payables/payment-requests/${id}`}>Reload this page</a>
                  ) : null
                }
              >
                {state.error}
              </Alert>
            ) : null}
            {cancel ? (
              <Field label="Reason" error={state.errors?.['reason']}>
                {(control) => (
                  <Textarea
                    name="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    maxLength={500}
                    required
                    {...control}
                  />
                )}
              </Field>
            ) : null}
            <PendingLine
              pending={pending}
              words={cancel ? 'Cancelling the request' : 'Submitting the request'}
            />
          </form>
        )}
      </div>
    </ActionDialog>
  );
}
