import { PR_STATUSES, PrStatusSchema, type PrStatus } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';

import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { listPurchaseRequests, type PurchaseRequestListItem } from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';

import layout from '../procurement.module.css';
import { prFailure } from './_lib/failure';
import { PR_STATUS_LABEL, prGrants } from './_lib/model';
import styles from './requests.module.css';

export const metadata: Metadata = { title: 'Purchase requests · Business OS' };
export const dynamic = 'force-dynamic';

/** The API returns a bare array with no total, so the page asks for this many and says when it hit the cap. */
const LIMIT = 100;

function href(status: PrStatus | undefined): string {
  return status === undefined
    ? '/procurement/requests'
    : `/procurement/requests?status=${encodeURIComponent(status)}`;
}

function Row({ pr, numberSystems }: { pr: PurchaseRequestListItem; numberSystems: NumberSystems }) {
  const status = PR_STATUS_LABEL[pr.status];
  return (
    <tr>
      <Td>
        <CellTitle
          title={
            <Link
              href={`/procurement/requests/${encodeURIComponent(pr.id)}`}
              className={styles.name}
            >
              {pr.number ?? 'Not numbered yet'}
            </Link>
          }
          note={<span className={styles.long}>{pr.justification}</span>}
        />
      </Td>
      <Td nowrap>
        {pr.departmentName ?? <span className={styles.numeric}>Department name unavailable</span>}
      </Td>
      <Td nowrap>{when(pr.requiredBy, 'date')}</Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>
          {money(pr.estimatedTotal, pr.currency, numberSystems)}
        </span>
      </Td>
      <Td nowrap>
        <span className={styles.badges}>
          <Badge tone={status.tone}>{status.text}</Badge>
          {pr.isEmergency ? <Badge tone="error">Emergency</Badge> : null}
        </span>
      </Td>
    </tr>
  );
}

export default async function PurchaseRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const session = await requireStaffSession('/procurement/requests');
  const numberSystems = await getNumberSystems();
  const params = await searchParams;
  const parsed = PrStatusSchema.safeParse(
    typeof params.status === 'string' ? params.status : undefined,
  );
  const status = parsed.success ? parsed.data : undefined;
  const grants = prGrants(session.roles);

  let requests: PurchaseRequestListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    requests = await listPurchaseRequests(session, {
      ...(status !== undefined ? { status } : {}),
      limit: LIMIT,
    });
  } catch (err) {
    const f = prFailure(err, 'load');
    problem = { message: f.message, status: f.status };
  }

  const newButton = grants.create ? (
    <LinkButton href="/procurement/requests/new">New purchase request</LinkButton>
  ) : null;

  return (
    <Page className={layout.list}>
      <PageHeader
        title={grants.readAll ? 'Purchase requests' : 'My purchase requests'}
        description={
          grants.readAll
            ? 'Every purchase request in this entity, newest first. A request is approved by the department head before sourcing starts.'
            : 'The purchase requests you raised, newest first. A request is approved by the department head before sourcing starts.'
        }
        actions={newButton}
      />

      <form method="get" action="/procurement/requests" className={layout.filters}>
        <Field label="Status">
          {(control) => (
            <Select name="status" defaultValue={status ?? ''} {...control}>
              <option value="">All statuses</option>
              {PR_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PR_STATUS_LABEL[s].text}
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
            <LinkButton href="/procurement/requests" variant="ghost">
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
              ? 'Your roles do not include purchase requests'
              : 'Purchase requests did not load'
          }
          actions={
            problem.status !== 403 ? (
              <Link href={href(status)}>Reload purchase requests</Link>
            ) : null
          }
        >
          {problem.status === 403
            ? 'Purchase requests are for staff who raise or source purchases. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : requests !== null && requests.length === 0 ? (
        status !== undefined ? (
          <EmptyState
            title={`No requests are ${PR_STATUS_LABEL[status].text.toLowerCase()}.`}
            icon="search"
            action={
              <LinkButton href="/procurement/requests" variant="secondary">
                Clear filter
              </LinkButton>
            }
          >
            Try another status.
          </EmptyState>
        ) : (
          <EmptyState title="No purchase requests yet." icon="file-text" action={newButton}>
            {grants.create
              ? 'Raise a request for what the business needs. The department head approves it before anyone sources it.'
              : 'Requests raised by staff will show here.'}
          </EmptyState>
        )
      ) : requests !== null ? (
        <div className={layout.results}>
          <Table className={layout.resultsTable ?? ''} caption="Purchase requests" minWidth={720}>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>Department</Th>
                <Th>Needed by</Th>
                <Th align="end">Estimated total</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {requests.map((pr) => (
                <Row numberSystems={numberSystems} key={pr.id} pr={pr} />
              ))}
            </tbody>
          </Table>
          <p className={layout.resultsNote}>
            {requests.length >= LIMIT
              ? `Showing the newest ${LIMIT} requests. Filter by status to narrow the list.`
              : `Showing ${requests.length} ${requests.length === 1 ? 'request' : 'requests'}`}
          </p>
        </div>
      ) : null}
    </Page>
  );
}
