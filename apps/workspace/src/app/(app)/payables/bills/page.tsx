import { BILL_STATUSES, BillStatusSchema, pageWindow } from '@bos/contracts';
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
import { listBillsPage, type BillListItem } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { when } from '@/lib/kernel-format';
import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from '@/lib/list-params';

import { poMoney } from '../../procurement/orders/_lib/model';
import { billFailure } from '../_lib/failure';
import { BILL_STATUS_LABEL, MATCH_STATUS_LABEL, billGrants } from '../_lib/model';
import styles from '../payables.module.css';
import { BillsFilters } from './bills-filters';

export const metadata: Metadata = { title: 'Bills · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/payables/bills';
const LIST = { multi: { status: BILL_STATUSES } } as const;

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
  const grants = billGrants(session.roles);

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
  const pageHref = (page: number) => hrefWith(PATH, params, { page: page > 1 ? page : null });
  const nearby = Array.from({ length: window.pageCount }, (_, i) => i + 1).filter(
    (n) => Math.abs(n - window.page) <= 2,
  );

  return (
    <Page>
      {header}
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
          <Table caption="Vendor bills, newest first" minWidth={900}>
            <thead>
              <tr>
                <Th>Bill</Th>
                <Th>Vendor</Th>
                <Th>Vendor invoice</Th>
                <Th>Invoice date</Th>
                <Th>Status</Th>
                <Th>Match</Th>
                <Th align="end">Payable</Th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const st = BILL_STATUS_LABEL[b.status];
                const match = MATCH_STATUS_LABEL[b.matchStatus];
                return (
                  <tr key={b.id}>
                    <Td>
                      <Link
                        href={`/payables/bills/${encodeURIComponent(b.id)}`}
                        className={styles.name}
                      >
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
                      <Badge tone={st.tone}>{st.text}</Badge>
                    </Td>
                    <Td nowrap>
                      <Badge tone={match.tone}>{match.text}</Badge>
                    </Td>
                    <Td align="end" nowrap>
                      <span className={styles.numeric}>
                        {poMoney(b.payableTotal, b.currency, numberSystems)}
                      </span>
                    </Td>
                  </tr>
                );
              })}
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
