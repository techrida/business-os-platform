import { PAYMENT_REQUEST_STATUSES, PaymentRequestStatusSchema, pageWindow } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { Table, Td, Th } from '@/components/ui/table';
import { listPaymentRequestsPage, type PaymentRequestListItem } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { getGrants, hasGrant } from '@/lib/grants';
import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from '@/lib/list-params';

import { poMoney } from '../../procurement/orders/_lib/model';
import { paymentRequestFailure } from './failure';
import { PAYMENT_STATUS } from './model';
import { PaymentRequestsFilters } from './payment-requests-filters';

export const metadata: Metadata = { title: 'Payment requests · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/payables/payment-requests';
const LIST = { multi: { status: PAYMENT_REQUEST_STATUSES } } as const;

export default async function PaymentRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireStaffSession(PATH);
  const numberSystems = await getNumberSystems();
  // Live grants (GET /v1/me), not the role defaults: an admin may grant payment requests to any role, at any scope.
  const allowed = hasGrant(await getGrants(session), 'payables.payment.request');
  const header = (
    <PageHeader
      title="Payment requests"
      description="Instructions to pay approved vendor bills. Approval does not send money."
      actions={
        allowed ? (
          <LinkButton href="/payables/payment-requests/new">New payment request</LinkButton>
        ) : null
      }
    />
  );
  if (!allowed)
    return (
      <Page>
        {header}
        <Alert tone="info" role="alert">
          Your roles do not include payment requests.
        </Alert>
      </Page>
    );
  const params = await searchParams;
  const list = readList(params, LIST);
  const status = PaymentRequestStatusSchema.array().parse(list.multi.status);
  let rows: PaymentRequestListItem[];
  let total = 0;
  let window = pageWindow(list.page, list.rows);
  try {
    const fetchPage = () =>
      listPaymentRequestsPage(session, {
        status,
        ...(list.q !== undefined ? { q: list.q } : {}),
        limit: window.limit,
        offset: window.offset,
      });
    let result = await fetchPage();
    // A page number past the end (a stale link) shows the last page instead of an empty table.
    const clamped = pageWindow(list.page, list.rows, result.total);
    if (result.items.length === 0 && result.total > 0 && clamped.page !== window.page) {
      window = clamped;
      result = await fetchPage();
    } else {
      window = clamped;
    }
    rows = result.items;
    total = result.total;
  } catch (err) {
    const f = paymentRequestFailure(err);
    return (
      <Page>
        {header}
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title="Payment requests did not load"
        >
          {f.message}
        </Alert>
      </Page>
    );
  }
  const filtered = activeFilterLabels(
    { q: list.q, multi: list.multi, single: {} },
    {
      status: {
        label: 'Status',
        format: (v) => PAYMENT_STATUS[v as keyof typeof PAYMENT_STATUS]?.text ?? v,
      },
    },
  );
  const pageHref = (page: number) => hrefWith(PATH, params, { page: page > 1 ? page : null });
  const nearby = Array.from({ length: window.pageCount }, (_, i) => i + 1).filter(
    (n) => Math.abs(n - window.page) <= 2,
  );
  return (
    <Page>
      {header}
      <PaymentRequestsFilters
        statusOptions={PAYMENT_REQUEST_STATUSES.map((value) => ({
          value,
          label: PAYMENT_STATUS[value].text,
        }))}
        status={status}
        rows={typeof params.rows === 'string' ? params.rows : undefined}
      />
      {rows.length === 0 ? (
        filtered.length > 0 ? (
          <EmptyState
            title="No payment requests match."
            icon="search"
            headingLevel={2}
            action={
              <LinkButton href={clearFiltersHref(PATH, params, LIST)} variant="secondary">
                Clear filters
              </LinkButton>
            }
          >
            Nothing matches {filtered.join(' · ')}.
          </EmptyState>
        ) : (
          <EmptyState title="No payment requests yet." icon="banknote" headingLevel={2}>
            Create a draft for approved vendor bills.
          </EmptyState>
        )
      ) : (
        <>
          <ResultCount shown={rows.length} total={total} noun="payment request" />
          <Table caption="Payment requests, newest first" minWidth={700}>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>Vendor</Th>
                <Th>Status</Th>
                <Th>Vendor bank account</Th>
                <Th align="end">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <Td>
                    <Link href={`/payables/payment-requests/${row.id}`}>
                      {row.number ?? 'Draft request'}
                    </Link>
                  </Td>
                  <Td>
                    <Link href={`/vendors/${row.vendorPartyId}`}>View vendor</Link>
                  </Td>
                  <Td>
                    <Badge tone={PAYMENT_STATUS[row.status].tone}>
                      {PAYMENT_STATUS[row.status].text}
                    </Badge>
                  </Td>
                  <Td>Ending {row.bankLast4}</Td>
                  <Td align="end">{poMoney(row.totalAmount, row.currency, numberSystems)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination
            label="Pages"
            summary={`Showing ${window.first}-${window.last} of ${total}`}
            {...(window.page > 1 ? { previousHref: pageHref(window.page - 1) } : {})}
            {...(window.page < window.pageCount ? { nextHref: pageHref(window.page + 1) } : {})}
            pages={nearby.map((n) => ({ page: n, href: pageHref(n) }))}
            currentPage={window.page}
          />
        </>
      )}
    </Page>
  );
}
