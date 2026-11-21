import { randomUUID } from 'node:crypto';

import type { CompanyBankAccount } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import {
  listPaymentRequestItems,
  listPaymentRequestItemsWithoutBankAccount,
  type PaymentRequestItem,
} from '@/lib/api-payables';
import { listPaymentRequestOrders } from '@/lib/api-payables-orders';
import { listCompanyBankAccounts } from '@/lib/api-company-accounts';
import { canOpenSection, settingsSection } from '@/lib/settings-nav';

import { PO_STATUS_LABEL } from '../../../procurement/orders/_lib/model';

import { PaymentRequestEntry } from '../forms';
import { paymentRequestFailure } from '../failure';
import {
  addBankAccountText,
  NEW_REQUEST_HEADING,
  requestableItem,
  vendorsWithoutBankAccount,
} from '../model';

export const metadata: Metadata = { title: 'New payment request · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewPaymentRequestPage({
  searchParams,
}: {
  searchParams?: Promise<{ bill?: string | string[] }>;
} = {}) {
  // `?bill=` comes from a bill's "Request payment" link: that bill starts filled in when it can still be requested.
  const bill = (await searchParams)?.bill;
  const billId = typeof bill === 'string' && isGuid(bill) ? bill : undefined;
  const session = await requireStaffSession(
    `/payables/payment-requests/new${billId !== undefined ? `?bill=${billId}` : ''}`,
  );
  // Live grants (GET /v1/me), not the role defaults: an admin may grant payment requests to any role, at any scope.
  const grants = await getGrants(session);
  const allowed = hasGrant(grants, 'payables.payment.request');
  // For a vendor without a verified bank account: what this reader can do about it, and whether its page opens.
  const addBank = addBankAccountText(hasGrant(grants, 'vendor.bank.propose'));
  const linkVendors = hasGrant(grants, 'vendor.read');
  // Where a paying bank account is added, linked only when this person may open that Settings page.
  const bankSettings = settingsSection('company-accounts');
  const bankAccountsHref = canOpenSection(bankSettings, (permission) =>
    hasGrant(grants, permission as Parameters<typeof hasGrant>[1]),
  )
    ? bankSettings.href
    : undefined;
  let bankAccounts: CompanyBankAccount[] = [];
  let items: PaymentRequestItem[] = [];
  // Balances held back only because the vendor has no verified bank account: named so the person knows what to fix.
  // Optional: if it does not load, the page says what it said before.
  let held: PaymentRequestItem[] = [];
  let orders: { id: string; vendorId: string; label: string }[] = [];
  let problem: string | undefined;
  const enabledCurrencies = allowed ? await loadEnabledCurrencies(session) : [];
  if (allowed) {
    const heldRead = listPaymentRequestItemsWithoutBankAccount(session).catch(
      () => [] as PaymentRequestItem[],
    );
    // Read beside the items: the paying account is required, so a failed read is said instead of a form.
    const bankRead = listCompanyBankAccounts(session).then(
      (rows) => ({ rows }),
      (err: unknown) => ({ err }),
    );
    try {
      items = await listPaymentRequestItems(session);
    } catch (err) {
      problem = paymentRequestFailure(err).message;
    }
    held = await heldRead;
    const bank = await bankRead;
    if ('rows' in bank) bankAccounts = bank.rows;
    else
      problem ??=
        paymentRequestFailure(bank.err).status === 403
          ? "Your roles do not allow reading the company's bank accounts. Ask an administrator if you need access."
          : "The company's bank accounts did not load. Reload the page to try again.";
    // The order is optional on a request: if the picker does not load, the request goes without one.
    orders = await listPaymentRequestOrders(session).then(
      (rows) =>
        rows.map((o) => ({
          id: o.id,
          vendorId: o.vendorId,
          label: `${o.number} · ${PO_STATUS_LABEL[o.status].text}`,
        })),
      () => [],
    );
  }
  const heldBill =
    billId !== undefined ? held.find((item) => item.vendorBillId === billId) : undefined;
  return (
    <Page>
      <Breadcrumb
        items={[
          { label: 'Payment requests', href: '/payables/payment-requests' },
          { label: 'New request' },
        ]}
      />
      {/* With the form on screen its heading carries Cancel and Create, so the form draws it. */}
      {allowed && !problem && items.length > 0 ? null : (
        <PageHeader
          title={NEW_REQUEST_HEADING.title}
          description={NEW_REQUEST_HEADING.description}
        />
      )}
      {allowed ? (
        problem ? (
          <Alert
            tone="error"
            role="alert"
            actions={<Link href="/payables/payment-requests/new">Reload this page</Link>}
          >
            {problem}
          </Alert>
        ) : items.length === 0 ? (
          held.length > 0 ? (
            <Alert tone="info" role="status" title="A vendor has no verified bank account">
              Approved bills from <VendorNames held={held} link={linkVendors} /> cannot be requested
              yet: a payment goes only to a verified bank account, and{' '}
              {vendorsWithoutBankAccount(held).length === 1
                ? 'this vendor has'
                : 'these vendors have'}{' '}
              none. {addBank}
            </Alert>
          ) : (
            <Alert tone="info" role="status">
              No approved bill balances are available for a payment request. Existing requests may
              have claimed the remaining balances.
            </Alert>
          )
        ) : (
          <>
            {heldBill !== undefined ? (
              <Alert tone="warning" role="status" title="This bill cannot be requested yet">
                {heldBill.billNumber ?? heldBill.vendorInvoiceNo} from{' '}
                <VendorNames held={[heldBill]} link={linkVendors} /> cannot be requested yet: a
                payment goes only to a verified bank account, and this vendor has none. {addBank}
              </Alert>
            ) : null}
            <PaymentRequestEntry
              idempotencyKey={randomUUID()}
              items={items}
              orders={orders}
              enabledCurrencies={enabledCurrencies}
              bankAccounts={bankAccounts}
              bankAccountsHref={bankAccountsHref}
              start={
                billId !== undefined ? requestableItem(items, billId, enabledCurrencies) : undefined
              }
            />
          </>
        )
      ) : (
        <Alert tone="info" role="alert">
          Your roles do not include payment requests.
        </Alert>
      )}
    </Page>
  );
}

/** The vendors of `held`, each linked to its page (where a bank account is proposed) when the reader may open it. */
function VendorNames({ held, link }: { held: readonly PaymentRequestItem[]; link: boolean }) {
  const vendors = vendorsWithoutBankAccount(held);
  return (
    <>
      {vendors.map((v, n) => (
        <span key={v.id}>
          {n > 0 ? (n === vendors.length - 1 ? ' and ' : ', ') : null}
          {link ? <Link href={`/vendors/${encodeURIComponent(v.id)}`}>{v.name}</Link> : v.name}
        </span>
      ))}
    </>
  );
}
