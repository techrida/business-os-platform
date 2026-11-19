import { randomUUID } from 'node:crypto';

import { pageWindow } from '@bos/contracts';
import type { Metadata } from 'next';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listBillSubmissionsPage, type BillSubmission } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from '@/lib/list-params';

import { RejectDialog } from '../_components/bill-actions';
import { billFailure } from '../_lib/failure';
import { billGrants, fileStatusLabel } from '../_lib/model';
import styles from '../payables.module.css';
import { InboxFilters } from './inbox-filters';

export const metadata: Metadata = { title: 'Bill inbox · Business OS' };
export const dynamic = 'force-dynamic';

/** Why a row cannot become a bill yet, or undefined when it can. */
function blocker(s: BillSubmission): string | undefined {
  if (s.fileStatus === 'infected' || s.fileStatus === 'failed') {
    return 'The file failed its scan. Reject this submission';
  }
  if (s.fileStatus !== 'clean') return 'Waiting for the file scan to pass';
  if (s.vendorPartyId === null) return 'The vendor is not named';
  if (s.vendorInvoiceNo === null || s.invoiceDate === null)
    return 'The invoice details are missing';
  return undefined;
}

const PATH = '/payables/inbox';
const LIST = { multi: {} } as const;

export default async function BillInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireStaffSession(PATH);
  const params = await searchParams;
  const list = readList(params, LIST);
  const grants = billGrants(session.roles);

  const header = (
    <PageHeader
      title="Bill inbox"
      description="Invoices vendors sent through the portal, oldest first. Key one in to make a bill, or reject it with a reason."
      actions={
        <LinkButton href="/payables/bills" variant="secondary">
          Open the bills
        </LinkButton>
      }
    />
  );

  let rows: BillSubmission[];
  let total = 0;
  let window = pageWindow(list.page, list.rows);
  try {
    const fetchPage = () =>
      listBillSubmissionsPage(session, {
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
    const f = billFailure(err, 'load');
    return (
      <Page>
        {header}
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open the inbox' : 'The inbox did not load'}
          actions={f.status !== 403 ? <a href={hrefWith(PATH, params, {})}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const filtered = activeFilterLabels({ q: list.q, multi: {}, single: {} }, {});
  const pageHref = (page: number) => hrefWith(PATH, params, { page: page > 1 ? page : null });
  const nearby = Array.from({ length: window.pageCount }, (_, i) => i + 1).filter(
    (n) => Math.abs(n - window.page) <= 2,
  );

  return (
    <Page>
      {header}
      <InboxFilters rows={typeof params.rows === 'string' ? params.rows : undefined} />
      <Panel
        title="Waiting for a bill"
        actions={<Badge tone="neutral">{filtered.length > 0 ? `${total} found` : total}</Badge>}
      >
        {rows.length === 0 ? (
          filtered.length > 0 ? (
            <EmptyState
              title="No submissions match."
              icon="search"
              headingLevel={3}
              action={
                <LinkButton href={clearFiltersHref(PATH, params, LIST)} variant="secondary">
                  Clear filters
                </LinkButton>
              }
            >
              Nothing matches {filtered.join(' · ')}.
            </EmptyState>
          ) : (
            <EmptyState title="The inbox is empty." icon="check-circle" headingLevel={3}>
              When a vendor sends an invoice through the portal, it appears here.
            </EmptyState>
          )
        ) : (
          <>
            <ResultCount shown={rows.length} total={total} noun="submission" />
            <Table caption="Vendor invoice submissions, oldest first" minWidth={980}>
              <thead>
                <tr>
                  <Th>Vendor</Th>
                  <Th>Invoice</Th>
                  <Th>Invoice date</Th>
                  <Th>Order</Th>
                  <Th>File</Th>
                  <Th>Received</Th>
                  <Th align="end">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const file = fileStatusLabel(s.fileStatus);
                  const why = blocker(s);
                  const label = s.vendorInvoiceNo ?? 'this submission';
                  return (
                    <tr key={s.id}>
                      <Td>
                        {s.vendorName !== null ? (
                          <span className={styles.name}>{s.vendorName}</span>
                        ) : (
                          <span className={styles.quiet}>Not named</span>
                        )}
                        {s.note !== null ? <span className={styles.rowNote}>{s.note}</span> : null}
                      </Td>
                      <Td>
                        {s.vendorInvoiceNo !== null ? (
                          <span className={styles.long}>{s.vendorInvoiceNo}</span>
                        ) : (
                          <span className={styles.quiet}>Missing</span>
                        )}
                      </Td>
                      <Td nowrap>
                        {s.invoiceDate !== null ? (
                          <time dateTime={s.invoiceDate}>{when(s.invoiceDate, 'date')}</time>
                        ) : (
                          <span className={styles.quiet}>Missing</span>
                        )}
                      </Td>
                      <Td nowrap>
                        {s.purchaseOrderId !== null ? (
                          'Against an order'
                        ) : (
                          <span className={styles.quiet}>No order</span>
                        )}
                      </Td>
                      <Td nowrap>
                        <Badge tone={file.tone}>{file.text}</Badge>
                      </Td>
                      <Td nowrap>
                        <time dateTime={s.receivedAt}>{when(s.receivedAt)}</time>
                      </Td>
                      <Td align="end">
                        {grants.enter ? (
                          <div className={styles.rowActions}>
                            {why === undefined ? (
                              <LinkButton
                                href={`/payables/bills/new?submission=${encodeURIComponent(s.id)}`}
                                variant="primary"
                              >
                                Create bill
                              </LinkButton>
                            ) : (
                              <span className={styles.note}>{why}</span>
                            )}
                            <RejectDialog
                              targetId={s.id}
                              label={label}
                              idempotencyKey={randomUUID()}
                              reloadHref="/payables/inbox"
                            />
                          </div>
                        ) : (
                          <span className={styles.note}>Accountants handle the inbox</span>
                        )}
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
      </Panel>
    </Page>
  );
}
