import { PO_STATUSES, PoStatusSchema, type PoStatus } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { parsePage } from '@/components/p2/customers/duplicates';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { getVendor } from '@/lib/api-vendors';
import { listPurchaseOrders, type PoListItem } from '@/lib/api-purchase-orders';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import type { Session } from '@/lib/session';

import { poFailure } from './_lib/failure';
import { PO_STATUS_LABEL, poMoney } from './_lib/model';
import styles from './orders.module.css';

export const metadata: Metadata = { title: 'Purchase orders · Business OS' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

function href(status: PoStatus | undefined, page: number): string {
  const params = new URLSearchParams();
  if (status !== undefined) params.set('status', status);
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text === '' ? '/procurement/orders' : `/procurement/orders?${text}`;
}

/** Vendor names for the rows on this page. Unreadable vendors show an explicit unavailable-name label. */
async function vendorNames(session: Session, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const settled = await Promise.allSettled(unique.map((id) => getVendor(session, id)));
  const names = new Map<string, string>();
  settled.forEach((r, i) => {
    const id = unique[i];
    if (id !== undefined && r.status === 'fulfilled') names.set(id, r.value.legalName);
  });
  return names;
}

function Row({ po, vendor }: { po: PoListItem; vendor: string | undefined }) {
  const status = PO_STATUS_LABEL[po.status];
  return (
    <tr>
      <Td>
        <Link href={`/procurement/orders/${encodeURIComponent(po.id)}`} className={styles.name}>
          {po.number}
        </Link>
      </Td>
      <Td>
        <CellTitle
          title={
            vendor !== undefined ? (
              <span className={styles.long}>{vendor}</span>
            ) : (
              <span className={styles.quiet}>Vendor name unavailable</span>
            )
          }
        />
      </Td>
      <Td nowrap>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>{poMoney(po.approvedTotal, po.currency)}</span>
      </Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>v{po.currentVersion}</span>
      </Td>
      <Td nowrap>
        {po.issuedAt !== null ? (
          <time dateTime={po.issuedAt}>{when(po.issuedAt, 'date')}</time>
        ) : (
          <span className={styles.quiet}>Not issued</span>
        )}
      </Td>
    </tr>
  );
}

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; page?: string | string[] }>;
}) {
  const session = await requireStaffSession('/procurement/orders');
  const params = await searchParams;
  const parsedStatus = PoStatusSchema.safeParse(
    typeof params.status === 'string' ? params.status : undefined,
  );
  const status = parsedStatus.success ? parsedStatus.data : undefined;
  const page = parsePage(params.page);

  let orders: PoListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    orders = await listPurchaseOrders(session, status);
  } catch (err) {
    const f = poFailure(err, 'load');
    problem = { message: f.message, status: f.status };
  }

  // The API answers the whole list, newest first, so the page slices it.
  const total = orders?.length ?? 0;
  const shown = orders?.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) ?? [];
  const names =
    shown.length > 0
      ? await vendorNames(
          session,
          shown.map((o) => o.vendorId),
        )
      : new Map<string, string>();
  const first = (page - 1) * PAGE_SIZE + 1;
  const hasNext = page * PAGE_SIZE < total;

  return (
    <Page>
      <PageHeader
        title="Purchase orders"
        description="Orders placed with approved vendors. An order is issued once, and every change after that is a new version."
        actions={
          orders !== null ? (
            <Badge tone="info" role="status" className={styles.count}>
              {total} {total === 1 ? 'order' : 'orders'}
            </Badge>
          ) : null
        }
      />

      <form method="get" action="/procurement/orders" role="search" className={styles.filters}>
        <Field label="Status">
          {(control) => (
            <Select name="status" defaultValue={status ?? ''} {...control}>
              <option value="">All statuses</option>
              {PO_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PO_STATUS_LABEL[s].text}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className={styles.filterActions}>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {status !== undefined ? (
            <LinkButton href="/procurement/orders" variant="ghost">
              Clear filter
            </LinkButton>
          ) : null}
        </div>
      </form>

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include purchase orders'
              : 'Purchase orders did not load'
          }
          actions={
            problem.status !== 403 ? (
              <Link href={href(status, page)}>Reload purchase orders</Link>
            ) : null
          }
        >
          {problem.status === 403
            ? 'Purchase orders are for the procurement team. Ask an administrator if you need access. To receive goods, open the receipts screen.'
            : problem.message}
        </Alert>
      ) : orders !== null && shown.length === 0 ? (
        status !== undefined ? (
          <EmptyState
            title={`No ${PO_STATUS_LABEL[status].text.toLowerCase()} purchase orders.`}
            icon="search"
            action={
              <LinkButton href="/procurement/orders" variant="secondary">
                Clear filter
              </LinkButton>
            }
          >
            Try another status.
          </EmptyState>
        ) : page > 1 ? (
          <EmptyState title="There are no more purchase orders.">
            <Link href={href(status, 1)}>Back to the first page</Link>
          </EmptyState>
        ) : (
          <EmptyState title="No purchase orders yet." icon="file-text">
            An order is drafted when a purchase request has an approved quotation. It appears here,
            ready to issue.
          </EmptyState>
        )
      ) : orders !== null ? (
        <>
          <Table caption="Purchase orders" minWidth={760}>
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Vendor</Th>
                <Th>Status</Th>
                <Th align="end">Approved total</Th>
                <Th align="end">Version</Th>
                <Th>Issued</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((po) => (
                <Row key={po.id} po={po} vendor={names.get(po.vendorId)} />
              ))}
            </tbody>
          </Table>
          <nav aria-label="Pages" className={styles.pager}>
            <span className={styles.note}>
              Showing {first} to {first + shown.length - 1} of {total}
            </span>
            <span className={styles.pagerLinks}>
              {page > 1 ? (
                <LinkButton href={href(status, page - 1)} variant="secondary" size="small">
                  Previous
                </LinkButton>
              ) : null}
              {hasNext ? (
                <LinkButton href={href(status, page + 1)} variant="secondary" size="small">
                  Next
                </LinkButton>
              ) : null}
            </span>
          </nav>
        </>
      ) : null}
    </Page>
  );
}
