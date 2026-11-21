import {
  pageWindow,
  VENDOR_KINDS,
  VENDOR_STATUSES,
  type VendorDto,
  type VendorKind,
  type VendorStatus,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { grantsFrom } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { StatCard } from '@/components/ui/stat-card';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { listVendors } from '@/lib/api-vendors';
import { requireStaffSession } from '@/lib/bff';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';
import { getMeOrNull } from '@/lib/live-permissions';
import { companyLogo } from '../customers/_lib/company-logo';
import { ListPager } from '../invoices/_components/list-pager';

import { countVendorsByBucket, type VendorCounts } from './_lib/counts';
import { vendorFailure } from './_lib/failure';
import { VENDOR_KIND_LABEL, VENDOR_STATUS_LABEL, vendorGrants } from './_lib/model';
import { VendorFilters } from './vendor-filters';

import styles from './vendors.module.css';

export const metadata: Metadata = { title: 'Vendors · Business OS' };
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 25;
/** The URL is the state: repeated `status` and `kind`, `q`, `page` and `rows` (the API caps a page at 100). */
const LIST = {
  multi: { status: VENDOR_STATUSES, kind: VENDOR_KINDS },
  rows: { allowed: [10, DEFAULT_PAGE_SIZE, 50, 100], default: DEFAULT_PAGE_SIZE },
} as const;
const FILTER_LABELS = {
  status: {
    label: 'Status',
    format: (v: string) => VENDOR_STATUS_LABEL[v as VendorStatus]?.text ?? v,
  },
  kind: { label: 'Kind', format: (v: string) => VENDOR_KIND_LABEL[v as VendorKind] ?? v },
};

function Row({ v }: { v: VendorDto }) {
  const status = VENDOR_STATUS_LABEL[v.status];
  const href = `/vendors/${encodeURIComponent(v.id)}`;
  // Two vendors can share a legal name; the PAN tells their row actions apart.
  const name = v.pan !== null ? `${v.legalName}, PAN ${v.pan}` : v.legalName;
  return (
    <tr>
      <Td>
        <div className={styles.identity}>
          <Avatar {...companyLogo(v)} />
          <CellTitle
            title={
              <Link href={href} className={styles.name}>
                {v.legalName}
              </Link>
            }
            note={
              v.tradeName !== null ? (
                <span className={styles.long}>
                  <span className="sr-only">Trade name: </span>
                  {v.tradeName}
                </span>
              ) : null
            }
          />
        </div>
      </Td>
      <Td nowrap>{VENDOR_KIND_LABEL[v.kind]}</Td>
      <Td nowrap>
        {v.pan !== null ? (
          <span className={styles.numeric}>{v.pan}</span>
        ) : (
          <span className={styles.quiet}>Not set</span>
        )}
      </Td>
      <Td nowrap>{v.country}</Td>
      <Td nowrap pinned>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
      <Td nowrap pinned>
        <Link href={href} className={styles.rowAction} aria-label={`View ${name}`}>
          <Icon name="chevron-right" size={20} />
        </Link>
      </Td>
    </tr>
  );
}

export default async function VendorsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const session = await requireStaffSession('/vendors');
  const params = await searchParams;
  const state = readList(params, LIST);
  const { q, page, rows: pageSize } = state;
  const status = state.multi.status as VendorStatus[];
  const kind = state.multi.kind as VendorKind[];
  const at = (patch: Parameters<typeof hrefWith>[2]) => hrefWith('/vendors', params, patch);

  let vendors: VendorDto[] | null = null;
  let total: number | null = null;
  let counts: VendorCounts | null = null;
  let problem: { message: string; status: number } | null = null;
  let window = pageWindow(page, pageSize);
  try {
    // The counts start first; the cards are a convenience and drop out on their own failure.
    const countsLoad = countVendorsByBucket(session);
    const fetchPage = () =>
      listVendors(session, {
        ...(q !== undefined ? { q } : {}),
        ...(status.length > 0 ? { status } : {}),
        ...(kind.length > 0 ? { kind } : {}),
        limit: window.limit,
        offset: window.offset,
      });
    let result = await fetchPage();
    // A page number past the end (a stale link) shows the last page instead of an empty table.
    const clamped = pageWindow(page, pageSize, result.total);
    if (result.items.length === 0 && result.total > 0 && clamped.page !== window.page) {
      window = clamped;
      result = await fetchPage();
    } else {
      window = clamped;
    }
    vendors = result.items;
    total = result.total;
    counts = await countsLoad;
  } catch (err) {
    const f = vendorFailure(err, 'load');
    problem = { message: f.message, status: f.status };
  }

  const live = grantsFrom(await getMeOrNull(session.accessToken), session.roles);
  const addButton = vendorGrants(live).write ? (
    <>
      <LinkButton href="/imports/vendors" variant="secondary" size="large">
        Import from CSV
      </LinkButton>
      <LinkButton href="/vendors/new" size="large">
        <span aria-hidden="true" className={styles.plus}>
          +
        </span>
        Add vendor
      </LinkButton>
    </>
  ) : null;
  const filtersOn = activeFilterLabels(state, FILTER_LABELS, 'Search');
  const clearHref = clearFiltersHref('/vendors', params, LIST);

  return (
    <Page>
      <PageHeader
        title="Vendors"
        description="Manage vendor profiles, verification and payment accounts."
        actions={addButton}
      />

      {counts !== null ? (
        <section className={styles.stats} aria-label="Vendors by status">
          <StatCard label="Vendors" value={counts.total} icon="building" />
          <StatCard label="Approved" value={counts.approved} icon="check-circle" tone="success" />
          <StatCard label="In onboarding" value={counts.onboarding} icon="shield-check" />
          <StatCard label="Inactive" value={counts.inactive} icon="x-circle" tone="neutral" />
        </section>
      ) : null}

      <VendorFilters
        status={status}
        kind={kind}
        rows={pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined}
      />
      {total !== null && vendors !== null ? (
        <ResultCount shown={vendors.length} total={total} noun="vendor" />
      ) : null}

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403 ? 'Your roles do not include vendors' : 'Vendors did not load'
          }
          actions={
            problem.status !== 403 ? (
              <Link href={at({ page: page > 1 ? page : null })}>Reload vendors</Link>
            ) : null
          }
        >
          {problem.status === 403
            ? 'Vendors are for the procurement and finance teams. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : vendors !== null && vendors.length === 0 ? (
        filtersOn.length > 0 ? (
          <EmptyState
            title="No vendors match."
            icon="search"
            action={
              <LinkButton href={clearHref} variant="secondary">
                Clear filters
              </LinkButton>
            }
          >
            Hidden by {filtersOn.join('; ')}. Check the spelling, or search by the PAN instead.
          </EmptyState>
        ) : page > 1 ? (
          <EmptyState title="There are no more vendors.">
            <Link href={at({ page: null })}>Back to the first page</Link>
          </EmptyState>
        ) : (
          <EmptyState title="No vendors yet." icon="building" action={addButton}>
            Add a vendor, then start its KYB review so it can be approved for purchases.
          </EmptyState>
        )
      ) : vendors !== null && total !== null ? (
        <div className={styles.results}>
          <Table caption="Vendors" minWidth={800}>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th>Kind</Th>
                <Th>PAN</Th>
                <Th>Country</Th>
                <Th pinned>Status</Th>
                <Th pinned>Action</Th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <Row key={v.id} v={v} />
              ))}
            </tbody>
          </Table>
          <ListPager
            pathname="/vendors"
            current={params}
            window={window}
            total={total}
            label="Vendor pages"
          />
        </div>
      ) : null}
    </Page>
  );
}
