import {
  VENDOR_STATUSES,
  VendorStatusSchema,
  type VendorDto,
  type VendorStatus,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { parsePage } from '@/components/p2/customers/duplicates';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { listVendors } from '@/lib/api-vendors';
import { requireStaffSession } from '@/lib/bff';
import { vendorFailure } from './_lib/failure';
import { VENDOR_KIND_LABEL, VENDOR_STATUS_LABEL, vendorGrants } from './_lib/model';

import styles from './vendors.module.css';

export const metadata: Metadata = { title: 'Vendors · Business OS' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
/** The longest search the page forwards: a longer one is cut, never sent whole to the API. */
const MAX_QUERY = 100;

function href(q: string, status: VendorStatus | undefined, page: number): string {
  const params = new URLSearchParams();
  if (q !== '') params.set('q', q);
  if (status !== undefined) params.set('status', status);
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text === '' ? '/vendors' : `/vendors?${text}`;
}

function Row({ v }: { v: VendorDto }) {
  const status = VENDOR_STATUS_LABEL[v.status];
  return (
    <tr>
      <Td>
        <div className={styles.identity}>
          <Avatar name={v.legalName} shape="circle" />
          <CellTitle
            title={
              <Link href={`/vendors/${encodeURIComponent(v.id)}`} className={styles.name}>
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
      <Td nowrap>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
    </tr>
  );
}

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string | string[];
    status?: string | string[];
    page?: string | string[];
  }>;
}) {
  const session = await requireStaffSession('/vendors');
  const params = await searchParams;
  const q = (typeof params.q === 'string' ? params.q.trim() : '').slice(0, MAX_QUERY);
  const statusParsed = VendorStatusSchema.safeParse(
    typeof params.status === 'string' ? params.status : undefined,
  );
  const status = statusParsed.success ? statusParsed.data : undefined;
  const page = parsePage(params.page);

  let vendors: VendorDto[] | null = null;
  let total: number | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    const result = await listVendors(session, {
      ...(q !== '' ? { q } : {}),
      ...(status !== undefined ? { status } : {}),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    vendors = result.items;
    total = result.total;
  } catch (err) {
    const f = vendorFailure(err, 'load');
    problem = { message: f.message, status: f.status };
  }

  const hasNext = vendors !== null && total !== null && page * PAGE_SIZE < total;
  const first = (page - 1) * PAGE_SIZE + 1;
  const addButton = vendorGrants(session.roles).write ? (
    <LinkButton href="/vendors/new">Add vendor</LinkButton>
  ) : null;
  const filtered = q !== '' || status !== undefined;

  return (
    <Page>
      <PageHeader
        title="Vendors"
        description="Manage vendor profiles, verification and payment accounts."
        status={
          total !== null ? (
            <Badge tone="info" role="status" className={styles.count}>
              {total} {total === 1 ? 'vendor' : 'vendors'}
            </Badge>
          ) : null
        }
        actions={addButton}
      />

      <form method="get" action="/vendors" role="search" className={styles.filters}>
        <Field label="Search vendors">
          {(control) => (
            <SearchInput
              placeholder="Legal name, trade name or PAN"
              name="q"
              defaultValue={q}
              maxLength={MAX_QUERY}
              autoComplete="off"
              {...control}
            />
          )}
        </Field>
        <Field label="Status">
          {(control) => (
            <Select name="status" defaultValue={status ?? ''} {...control}>
              <option value="">All statuses</option>
              {VENDOR_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {VENDOR_STATUS_LABEL[s].text}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className={styles.filterActions}>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {filtered ? (
            <LinkButton href="/vendors" variant="ghost">
              Clear filters
            </LinkButton>
          ) : null}
        </div>
      </form>

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403 ? 'Your roles do not include vendors' : 'Vendors did not load'
          }
          actions={
            problem.status !== 403 ? <Link href={href(q, status, page)}>Reload vendors</Link> : null
          }
        >
          {problem.status === 403
            ? 'Vendors are for the procurement and finance teams. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : vendors !== null && vendors.length === 0 ? (
        filtered ? (
          <EmptyState
            title={q !== '' ? `No vendors match "${q}".` : 'No vendors have this status.'}
            icon="search"
            action={
              <LinkButton href="/vendors" variant="secondary">
                Clear filters
              </LinkButton>
            }
          >
            Check the spelling, search by the PAN instead, or try another status.
          </EmptyState>
        ) : page > 1 ? (
          <EmptyState title="There are no more vendors.">
            <Link href={href(q, status, 1)}>Back to the first page</Link>
          </EmptyState>
        ) : (
          <EmptyState title="No vendors yet." icon="building" action={addButton}>
            Add a vendor, then start its KYB review so it can be approved for purchases.
          </EmptyState>
        )
      ) : vendors !== null ? (
        <>
          <Table caption="Vendors" minWidth={720}>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th>Kind</Th>
                <Th>PAN</Th>
                <Th>Country</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <Row key={v.id} v={v} />
              ))}
            </tbody>
          </Table>
          <Pagination
            label="Pages"
            summary={`Showing ${first} to ${first + vendors.length - 1}${total !== null ? ` of ${total}` : ''}`}
            {...(page > 1 ? { previousHref: href(q, status, page - 1) } : {})}
            {...(hasNext ? { nextHref: href(q, status, page + 1) } : {})}
          />
        </>
      ) : null}
    </Page>
  );
}
