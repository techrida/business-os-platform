import {
  BILL_STATUSES,
  BillStatusSchema,
  DEFAULT_ROWS,
  ROWS_OPTIONS,
  pageWindow,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import layout from '@/components/p3/list.module.css';
import {
  listBillsPage,
  listPaymentRequestItems,
  type BillListItem,
  type PaymentRequestItem,
} from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { getGrants, hasGrant } from '@/lib/grants';
import { when } from '@/lib/kernel-format';
import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from '@/lib/list-params';

import { ListPager } from '../../invoices/_components/list-pager';
import { poMoney } from '../../procurement/orders/_lib/model';
import { billFailure } from '../_lib/failure';
import { BILL_STATUS_LABEL, MATCH_STATUS_LABEL, billGrants } from '../_lib/model';
import { BILL_COUNT_CARDS, countCards } from '../_lib/summary';
import { requestableItem } from '../payment-requests/model';
import styles from '../payables.module.css';
import { BillsFilters } from './bills-filters';

export const metadata: Metadata = { title: 'Bills · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/payables/bills';
/** ListPager offers every ROWS_OPTIONS choice, so the list accepts each one. */
const LIST = {
  multi: { status: BILL_STATUSES },
  rows: { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS },
} as const;

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const list = readList(params, LIST);
  const status = BillStatusSchema.array().parse(list.multi.status);

  const session = await requireStaffSession(PATH);

  const numberSystems = await getNumberSystems();
  const grants = billGrants(await getGrants(session));

  const header = (
    <PageHeader
      title="Bills"
      description="Vendor invoices keyed in, matched against their purchase orders and receipts, and sent for approval."
      actions={
        grants.enter ? (
          <div className={styles.headActions}>
            <LinkButton href="/payables/bills/new">New bill</LinkButton>
            <LinkButton href="/payables/inbox" variant="secondary">
              Open the inbox
            </LinkButton>
          </div>
        ) : null
      }
    />
  );

  // The count cards: every bill this person may open, whatever the filters. A failed read hides them, not the table.
  const counts = countCards(BILL_COUNT_CARDS, (statuses) =>
    listBillsPage(session, { status: statuses, limit: 1, offset: 0 }).then((r) => r.total),
  );
  // "Request payment" on a row: only for someone the payment request form lets in (the same check it makes), and
  // only on a bill with a balance still free to claim, in any currency (D56 U16-Q1). If that read fails the rows
  // just go without it.
  const mayRequest = hasGrant(await getGrants(session), 'payables.payment.request');
  const requestable: Promise<PaymentRequestItem[]> = mayRequest
    ? listPaymentRequestItems(session).catch(() => [])
    : Promise.resolve([]);
  let bills: BillListItem[];
  let total = 0;
  let window = pageWindow(list.page, list.rows);
  try {
    const fetchPage = () =>
      listBillsPage(session, {
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
    bills = result.items;
    total = result.total;
  } catch (err) {
    const f = billFailure(err, 'load');
    return (
      <Page>
        {header}
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open the bills' : 'The bills did not load'}
          actions={
            f.status !== 403 ? <Link href={hrefWith(PATH, params, {})}>Try again</Link> : null
          }
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
        format: (v) => BILL_STATUS_LABEL[v as keyof typeof BILL_STATUS_LABEL]?.text ?? v,
      },
    },
  );
  const cards = await counts;
  const payable = await requestable;

  return (
    <Page>
      {header}
      {cards !== null ? (
        <section aria-label="Bill summary" className={styles.stats}>
          {cards.map((card) => (
            <StatCard
              key={card.key}
              label={card.label}
              value={card.value}
              icon={card.icon}
              tone={card.tone}
            />
          ))}
        </section>
      ) : null}
      <BillsFilters
        statusOptions={BILL_STATUSES.map((s) => ({ value: s, label: BILL_STATUS_LABEL[s].text }))}
        status={status}
        rows={typeof params.rows === 'string' ? params.rows : undefined}
      />
      {bills.length === 0 ? (
        filtered.length > 0 ? (
          <EmptyState
            title="No bills match."
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
          <EmptyState
            title="No bills yet."
            icon="file-text"
            headingLevel={2}
            action={
              grants.enter ? (
                <LinkButton href="/payables/inbox" variant="secondary">
                  Open the inbox
                </LinkButton>
              ) : undefined
            }
          >
            A bill appears here once an invoice from the inbox is keyed in.
          </EmptyState>
        )
      ) : (
        <>
          <ResultCount shown={bills.length} total={total} noun="bill" />
          <div className={layout.results}>
            <Table caption="Vendor bills, newest first" minWidth={1000}>
              <thead>
                <tr>
                  <Th>Bill</Th>
                  <Th>Vendor</Th>
                  <Th>Vendor invoice</Th>
                  <Th>Invoice date</Th>
                  <Th>Match</Th>
                  <Th align="end">Payable</Th>
                  <Th pinned>Status</Th>
                  <Th pinned>Action</Th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => {
                  const st = BILL_STATUS_LABEL[b.status];
                  const match = MATCH_STATUS_LABEL[b.matchStatus];
                  const href = `/payables/bills/${encodeURIComponent(b.id)}`;
                  // Drafts share a name, so the action is named by the vendor's invoice too: one name per row.
                  const name = `${b.number ?? 'draft bill'} for invoice ${b.vendorInvoiceNo} from ${b.vendorName}`;
                  return (
                    <tr key={b.id}>
                      <Td nowrap>
                        <Link href={href} className={styles.name}>
                          {b.number ?? 'Draft bill'}
                        </Link>
                        {b.kind === 'vendor_credit_note' ? (
                          <span className={styles.note}> Credit note</span>
                        ) : null}
                      </Td>
                      <Td>
                        <span className={styles.long}>{b.vendorName}</span>
                      </Td>
                      <Td>
                        <span className={styles.long}>{b.vendorInvoiceNo}</span>
                      </Td>
                      <Td nowrap>
                        <time dateTime={b.invoiceDate}>{when(b.invoiceDate, 'date')}</time>
                      </Td>
                      <Td nowrap>
                        <Badge tone={match.tone}>{match.text}</Badge>
                      </Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>
                          {poMoney(b.payableTotal, b.currency, numberSystems)}
                        </span>
                      </Td>
                      <Td nowrap pinned>
                        <Badge tone={st.tone}>{st.text}</Badge>
                      </Td>
                      <Td nowrap pinned>
                        <span className={styles.rowActions}>
                          {requestableItem(payable, b.id) !== undefined ? (
                            <LinkButton
                              href={`/payables/payment-requests/new?bill=${encodeURIComponent(b.id)}`}
                              variant="secondary"
                              size="small"
                              aria-label={`Request payment of ${name}`}
                            >
                              Request payment
                            </LinkButton>
                          ) : null}
                          <Link
                            href={href}
                            className={styles.rowAction}
                            aria-label={`View ${name}`}
                          >
                            <Icon name="chevron-right" size={20} />
                          </Link>
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <ListPager
              pathname={PATH}
              current={params}
              window={window}
              total={total}
              label="Bill pages"
            />
          </div>
        </>
      )}
    </Page>
  );
}
