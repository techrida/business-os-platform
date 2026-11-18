import { RFQ_STATUSES, RfqStatusSchema, type RfqListItem, type RfqStatus } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';

import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { listRfqs } from '@/lib/api-rfqs';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import layout from '../procurement.module.css';
import styles from '../requests/requests.module.css';
import { rfqFailure } from './_lib/failure';
import { RFQ_STATUS_LABEL, rfqGrants } from './_lib/model';

export const metadata: Metadata = { title: 'Requests for quotation · Business OS' };
export const dynamic = 'force-dynamic';

/** The API returns a bare array with no total, so the page asks for this many and says when it hit the cap. */
const LIMIT = 100;

function href(status: RfqStatus | undefined): string {
  return status === undefined
    ? '/procurement/rfqs'
    : `/procurement/rfqs?status=${encodeURIComponent(status)}`;
}

function Row({ rfq }: { rfq: RfqListItem }) {
  const status = RFQ_STATUS_LABEL[rfq.status];
  return (
    <tr>
      <Td>
        <CellTitle
          title={
            <Link href={`/procurement/rfqs/${encodeURIComponent(rfq.id)}`} className={styles.name}>
              {rfq.number}
            </Link>
          }
        />
      </Td>
      <Td nowrap>
        <Link
          href={`/procurement/requests/${encodeURIComponent(rfq.purchaseRequestId)}`}
          className={styles.numeric}
        >
          {rfq.purchaseRequestNumber ?? 'Not numbered yet'}
        </Link>
      </Td>
      <Td nowrap>{when(rfq.deadline)}</Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>
          {rfq.quotationCount} of {rfq.invitedVendorCount}
        </span>
      </Td>
      <Td nowrap>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
    </tr>
  );
}

export default async function RfqsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const session = await requireStaffSession('/procurement/rfqs');
  const params = await searchParams;
  const parsed = RfqStatusSchema.safeParse(
    typeof params.status === 'string' ? params.status : undefined,
  );
  const status = parsed.success ? parsed.data : undefined;
  const grants = rfqGrants(session.roles);

  let rfqs: RfqListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    rfqs = await listRfqs(session, {
      ...(status !== undefined ? { status } : {}),
      limit: LIMIT,
    });
  } catch (err) {
    const f = rfqFailure(err, 'load');
    problem = { message: f.message, status: f.status };
  }

  return (
    <Page className={layout.list}>
      <PageHeader
        title="Requests for quotation"
        description="RFQs sent to approved vendors for a department-approved purchase request, newest first. Open one to enter quotations, compare them and recommend one."
        actions={
          grants.sourcing ? <LinkButton href="/procurement/rfqs/new">New RFQ</LinkButton> : null
        }
      />

      <form method="get" action="/procurement/rfqs" className={layout.filters}>
        <Field label="Status">
          {(control) => (
            <Select name="status" defaultValue={status ?? ''} {...control}>
              <option value="">All statuses</option>
              {RFQ_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {RFQ_STATUS_LABEL[s].text}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className={layout.filterActions}>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {status !== undefined ? (
            <LinkButton href="/procurement/rfqs" variant="ghost">
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
              ? 'Your roles do not include sourcing'
              : 'Requests for quotation did not load'
          }
          actions={problem.status !== 403 ? <Link href={href(status)}>Reload the list</Link> : null}
        >
          {problem.status === 403
            ? 'RFQs are for procurement staff who source purchases. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : rfqs !== null && rfqs.length === 0 ? (
        status !== undefined ? (
          <EmptyState
            title={`No RFQs are ${RFQ_STATUS_LABEL[status].text.toLowerCase()}.`}
            icon="search"
            action={
              <LinkButton href="/procurement/rfqs" variant="secondary">
                Clear filter
              </LinkButton>
            }
          >
            Try another status.
          </EmptyState>
        ) : (
          <EmptyState
            title="No RFQs yet."
            icon="file-text"
            action={
              grants.sourcing ? <LinkButton href="/procurement/rfqs/new">New RFQ</LinkButton> : null
            }
          >
            {grants.sourcing
              ? 'Open an RFQ on a department-approved purchase request to ask approved vendors for quotations.'
              : 'RFQs opened by procurement will show here.'}
          </EmptyState>
        )
      ) : rfqs !== null ? (
        <div className={layout.results}>
          <Table
            className={layout.resultsTable ?? ''}
            caption="Requests for quotation"
            minWidth={720}
          >
            <thead>
              <tr>
                <Th>RFQ</Th>
                <Th>Purchase request</Th>
                <Th>Deadline</Th>
                <Th align="end">Quotations</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rfqs.map((rfq) => (
                <Row key={rfq.id} rfq={rfq} />
              ))}
            </tbody>
          </Table>
          <p className={layout.resultsNote}>
            {rfqs.length >= LIMIT
              ? `Showing the newest ${LIMIT} RFQs. Filter by status to narrow the list.`
              : `Showing ${rfqs.length} ${rfqs.length === 1 ? 'RFQ' : 'RFQs'}`}
          </p>
        </div>
      ) : null}
    </Page>
  );
}
