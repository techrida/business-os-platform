import type { QuotationListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listQuotations } from '@/components/p2/quotations/api';
import styles from '@/components/p2/quotations/list.module.css';
import {
  parseStatusFilter,
  quotationStatusMeta,
  STATUS_FILTER_OPTIONS,
} from '@/components/p2/quotations/status';
import { newQuotationHref } from '@/components/p2/quotations/resume';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

export const metadata: Metadata = { title: 'Quotations · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The opportunity filter: one UUID, else none (a malformed id is ignored, never sent). */
function parseOpportunityFilter(raw: string | string[] | undefined): string | undefined {
  return typeof raw === 'string' && UUID.test(raw) ? raw : undefined;
}

/** This list's URL for the given filters, so the form, reload and links keep both. */
function listHref(filter: { status?: string | undefined; opportunityId?: string | undefined }) {
  const params = new URLSearchParams();
  if (filter.opportunityId !== undefined) params.set('opportunityId', filter.opportunityId);
  if (filter.status !== undefined) params.set('status', filter.status);
  return params.size === 0 ? '/quotations' : `/quotations?${params.toString()}`;
}

function QuotationRow({ item }: { item: QuotationListItem }) {
  return (
    <tr>
      <Td nowrap>
        <Link href={`/quotations/${encodeURIComponent(item.id)}`} className={styles.number}>
          {item.number}
        </Link>
      </Td>
      <Td>
        <span className={styles.customer}>{item.customerName}</span>
      </Td>
      <Td nowrap>
        <QuotationStatusBadge status={item.status} />
      </Td>
      <Td align="end" nowrap>
        <span className={styles.amount}>{money(item.total, item.currency)}</span>
      </Td>
      <Td nowrap>
        <time dateTime={item.validUntil}>{when(item.validUntil, 'date')}</time>
      </Td>
      <Td>
        {item.ownerName !== null ? (
          item.ownerName
        ) : (
          <span className={styles.quiet}>Unassigned</span>
        )}
      </Td>
    </tr>
  );
}

export default async function QuotationsPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ status?: string | string[]; opportunityId?: string | string[] }>;
}) {
  const { status: rawStatus, opportunityId: rawOpportunity } = await searchParams;
  const status = parseStatusFilter(rawStatus);
  const opportunityId = parseOpportunityFilter(rawOpportunity);
  const here = listHref({ status, opportunityId });
  const session = await requireStaffSession(here);

  let items: QuotationListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await listQuotations(session, {
      ...(status !== undefined ? { status } : {}),
      ...(opportunityId !== undefined ? { opportunityId } : {}),
    });
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  return (
    <Page>
      <PageHeader
        title={opportunityId !== undefined ? 'Quotations for this opportunity' : 'Quotations'}
        description={
          opportunityId !== undefined
            ? 'Open a draft to carry on with it, or start another quotation for the same opportunity.'
            : 'Every quotation with its customer, status, total and the date it stops being valid.'
        }
        actions={
          <>
            {items !== null && items.length > 0 ? (
              <Badge tone="info" role="status" className={styles.count}>
                {items.length} {items.length === 1 ? 'quotation' : 'quotations'}
                {status !== undefined ? ` · ${quotationStatusMeta(status).label}` : ''}
              </Badge>
            ) : null}
            {opportunityId !== undefined ? (
              <LinkButton
                href={newQuotationHref(opportunityId, { another: true })}
                variant="secondary"
              >
                New quotation
              </LinkButton>
            ) : null}
          </>
        }
      />

      <form method="get" action="/quotations" className={styles.toolbar}>
        {opportunityId !== undefined ? (
          <input type="hidden" name="opportunityId" value={opportunityId} />
        ) : null}
        <div className={styles.filterField}>
          <Field label="Status">
            {(control) => (
              <Select name="status" defaultValue={status ?? ''} {...control}>
                <option value="">All statuses</option>
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className={styles.toolbarActions}>
          <Button type="submit" variant="secondary">
            Apply filter
          </Button>
          {status !== undefined || opportunityId !== undefined ? (
            <Link href="/quotations">Show all quotations</Link>
          ) : null}
          {opportunityId !== undefined ? (
            <Link href={`/opportunities/${encodeURIComponent(opportunityId)}`}>
              Back to the opportunity
            </Link>
          ) : null}
        </div>
      </form>

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include quotations'
              : 'The quotations did not load'
          }
          actions={problem.status !== 403 ? <Link href={here}>Reload the quotations</Link> : null}
        >
          {problem.status === 403
            ? 'Quotations are for the sales team and the people who approve them. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : items !== null && items.length === 0 ? (
        status !== undefined ? (
          <EmptyState
            icon="file-text"
            title={`No quotations are ${quotationStatusMeta(status).label.toLowerCase()}.`}
          >
            Choose another status, or show all quotations.
          </EmptyState>
        ) : opportunityId !== undefined ? (
          <EmptyState icon="file-text" title="No quotations for this opportunity yet.">
            Start one with New quotation. It appears here once it is saved.
          </EmptyState>
        ) : (
          <EmptyState icon="file-text" title="No quotations yet.">
            A quotation is prepared from an opportunity. It appears here once it is saved.
          </EmptyState>
        )
      ) : items !== null ? (
        <Table caption="Quotations" minWidth={760}>
          <thead>
            <tr>
              <Th>Quotation</Th>
              <Th>Customer</Th>
              <Th>Status</Th>
              <Th align="end">Total</Th>
              <Th>Valid until</Th>
              <Th>Owner</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <QuotationRow key={item.id} item={item} />
            ))}
          </tbody>
        </Table>
      ) : null}
    </Page>
  );
}
