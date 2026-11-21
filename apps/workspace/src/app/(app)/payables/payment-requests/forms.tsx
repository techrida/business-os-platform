'use client';

import { CURRENCIES, type CompanyBankAccount, type Currency } from '@bos/contracts';
import Link from 'next/link';
import { useActionState, useId, useRef, useState } from 'react';

import {
  ActionDialog,
  PendingLine,
  useFocusOnProblem,
} from '@/components/p2/quotations/action-dialog';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { MoneyInput } from '@/components/ui/number-input';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Field, Select, Textarea } from '@/components/ui/field';
import type { PaymentRequestItem } from '@/lib/api-payables';
import { bankAccountOptions } from '@/lib/company-account-options';
import { money } from '@/lib/kernel-format';

import type { ActionState } from '../../procurement/orders/_lib/state';
import styles from '../payables.module.css';
import {
  cancelPaymentRequestAction,
  createPaymentRequestAction,
  submitPaymentRequestAction,
} from './actions';
import { NEW_REQUEST_HEADING } from './model';

export function PaymentRequestEntry({
  idempotencyKey,
  items,
  orders = [],
  start,
  bankAccounts = [],
  bankAccountsHref,
}: {
  idempotencyKey: string;
  items: PaymentRequestItem[];
  /** The bill item chosen from the bills list ("Request payment"): its vendor, currency and balance start filled in. */
  start?: PaymentRequestItem | undefined;
  /**
   * The orders a payment request can name (the payables picker), each with its vendor and the text the
   * picker shows. Only the chosen vendor's orders are offered.
   */
  orders?: readonly { id: string; vendorId: string; label: string }[];
  /**
   * The company's active bank accounts, read once on the server. "Pay from bank account" offers those in
   * the request currency.
   */
  bankAccounts?: readonly CompanyBankAccount[];
  /**
   * Where a bank account is added (Settings), when this person may open that page. Without it, the
   * no-account message names the place without a link.
   */
  bankAccountsHref?: string | undefined;
}) {
  const numberSystems = useNumberSystems();
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createPaymentRequestAction,
    { key: idempotencyKey },
  );
  const [header, setHeader] = useState<{
    vendorPartyId: string;
    fromBankAccountId: string;
    purchaseOrderId: string;
    currency: string;
  }>({
    vendorPartyId: start?.vendorPartyId ?? '',
    fromBankAccountId: '',
    purchaseOrderId: '',
    currency: start?.currency ?? 'NPR',
  });
  const [bankOpen, setBankOpen] = useState(false);
  /** The chosen account stays only while it holds `currency`; otherwise the choice is cleared. */
  const accountFor = (id: string, currency: string) =>
    bankAccounts.some((account) => account.id === id && account.currency === currency) ? id : '';
  const [rows, setRows] = useState([
    { openItemId: start?.openItemId ?? '', amount: start?.availableAmount ?? '' },
  ]);
  const wrap = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrap, summary);
  const errors = state.errors ?? {};
  const vendors = [
    ...new Map(items.map((item) => [item.vendorPartyId, item.vendorName])).entries(),
  ];
  /**
   * The currencies of a vendor's approved bills, NPR first, then the fixed order. Every one may be
   * requested, switched off in Settings or not (D56 U16-Q1).
   */
  const currenciesOf = (vendorPartyId: string) => {
    const billed = new Set<string>(
      items.filter((item) => item.vendorPartyId === vendorPartyId).map((item) => item.currency),
    );
    return CURRENCIES.filter((currency) => billed.has(currency));
  };
  const currencies = currenciesOf(header.vendorPartyId);
  const eligible = items.filter(
    (item) => item.vendorPartyId === header.vendorPartyId && item.currency === header.currency,
  );
  const vendorOrders = orders.filter((o) => o.vendorId === header.vendorPartyId);
  const bankOptions =
    header.currency === ''
      ? []
      : bankAccountOptions(bankAccounts, {
          currency: header.currency as Currency,
          currentId: header.fromBankAccountId,
        });
  const noBankAccount = `No active ${header.currency} bank account.`;
  const bankHint =
    header.currency !== '' && bankOptions.length === 0 ? (
      <>
        {noBankAccount}{' '}
        {bankAccountsHref !== undefined ? (
          <>
            Add one in <Link href={bankAccountsHref}>Settings &gt; Bank and expense accounts</Link>.
          </>
        ) : (
          'Ask an administrator to add one in Settings > Bank and expense accounts.'
        )}
      </>
    ) : undefined;
  const formId = useId();
  return (
    <>
      <PageHeader
        title={NEW_REQUEST_HEADING.title}
        description={NEW_REQUEST_HEADING.description}
        actions={
          <>
            <LinkButton href="/payables/payment-requests" variant="secondary">
              Cancel
            </LinkButton>
            <Button
              type="submit"
              form={formId}
              disabled={pending || eligible.length === 0}
              aria-busy={pending || undefined}
            >
              Create draft request
            </Button>
          </>
        }
      />
      <div ref={wrap}>
        <form id={formId} action={action} noValidate className={styles.form}>
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
                      const currency = currenciesOf(vendorPartyId)[0] ?? '';
                      setHeader((current) => ({
                        ...current,
                        vendorPartyId,
                        purchaseOrderId: '',
                        currency,
                        fromBankAccountId: accountFor(current.fromBankAccountId, currency),
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
              <Field
                label="Pay from bank account"
                hint={bankHint}
                error={errors['fromBankAccountId']}
              >
                {(control) => (
                  <>
                    <input
                      type="hidden"
                      name="fromBankAccountId"
                      value={header.fromBankAccountId}
                    />
                    <Combobox
                      labelledBy={control['aria-labelledby']}
                      describedBy={control['aria-describedby']}
                      invalid={control['aria-invalid'] === true}
                      options={bankOptions}
                      value={header.fromBankAccountId}
                      onChange={(fromBankAccountId) =>
                        setHeader((current) => ({ ...current, fromBankAccountId }))
                      }
                      open={bankOpen}
                      onOpenChange={setBankOpen}
                      placeholder="Search by bank, name or last four"
                      emptyText={
                        header.currency === '' ? 'Choose a currency first.' : noBankAccount
                      }
                      noMatchText="No bank account matches."
                      required
                    />
                  </>
                )}
              </Field>
              <Field label="Purchase order (optional)" error={errors['purchaseOrderId']}>
                {(control) => (
                  <Select
                    name="purchaseOrderId"
                    value={header.purchaseOrderId}
                    onChange={(e) =>
                      setHeader((current) => ({ ...current, purchaseOrderId: e.target.value }))
                    }
                    disabled={header.vendorPartyId === '' || vendorOrders.length === 0}
                    {...control}
                  >
                    <option value="">
                      {header.vendorPartyId !== '' && vendorOrders.length === 0
                        ? 'This vendor has no purchase orders'
                        : 'No purchase order'}
                    </option>
                    {vendorOrders.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Currency" error={errors['currency']}>
                {(control) => (
                  <Select
                    name="currency"
                    value={header.currency}
                    onChange={(e) => {
                      const currency = e.target.value;
                      setHeader((current) => ({
                        ...current,
                        currency,
                        fromBankAccountId: accountFor(current.fromBankAccountId, currency),
                      }));
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
                      <MoneyInput
                        {...control}
                        name={`allocation:${i}:amount`}
                        currency={(header.currency || 'NPR') as Currency}
                        value={row.amount}
                        onValueChange={(amount) =>
                          setRows((current) =>
                            current.map((line, index) =>
                              index === i ? { ...line, amount } : line,
                            ),
                          )
                        }
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
                      onClick={() =>
                        setRows((current) => current.filter((_, index) => index !== i))
                      }
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
          <PendingLine pending={pending} words="Creating the payment request" />
        </form>
      </div>
    </>
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
