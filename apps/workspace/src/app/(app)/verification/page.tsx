import type { CustomerDto, VerificationCaseDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { getCustomer, listVerificationCases } from '@/components/p2/customers/api';
import {
  checklistProgress,
  customerLabel,
  parseStatusFilter,
  VERIFICATION_STATUS_LABEL,
  type StatusFilter,
} from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { TabNav } from '@/components/ui/tab-nav';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import type { Session } from '@/lib/session';

import styles from './verification.module.css';

export const metadata: Metadata = { title: 'Verification · Business OS' };
export const dynamic = 'force-dynamic';

const FILTERS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'submitted', label: 'Awaiting review' },
  { value: 'approved', label: 'Verified' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired', label: 'Expired' },
  { value: 'draft', label: 'Draft' },
  { value: 'all', label: 'All cases' },
];

function filterHref(status: StatusFilter) {
  return status === 'submitted' ? '/verification' : `/verification?status=${status}`;
}

/** The queue asks for customer names one by one; past this many cases it shows ids instead. */
const NAME_LOOKUP_LIMIT = 50;

async function customerNames(
  session: Session,
  cases: readonly VerificationCaseDto[],
): Promise<Map<string, CustomerDto>> {
  const ids = [...new Set(cases.map((c) => c.partyId))].slice(0, NAME_LOOKUP_LIMIT);
  const settled = await Promise.allSettled(ids.map((id) => getCustomer(session, id)));
  const names = new Map<string, CustomerDto>();
  settled.forEach((result, i) => {
    const id = ids[i];
    if (result.status === 'fulfilled' && id !== undefined) names.set(id, result.value);
  });
  return names;
}

function Row({ c, customer }: { c: VerificationCaseDto; customer: CustomerDto | undefined }) {
  const status = VERIFICATION_STATUS_LABEL[c.status];
  const progress = checklistProgress(c.checklist);
  const name = customerLabel(customer, c.partyId);
  return (
    <tr>
      <Td className={styles.customerCell}>
        <div className={styles.customer}>
          {customer !== undefined ? (
            <Avatar name={name} size="medium" shape="circle" />
          ) : (
            <span className={styles.customerIcon}>
              <Icon name="building" size={16} />
            </span>
          )}
          <CellTitle
            title={<Link href={`/verification/${encodeURIComponent(c.id)}`}>{name}</Link>}
            note={
              customer !== undefined ? (
                <>
                  <span className="sr-only">Customer number: </span>
                  {customer.number}
                </>
              ) : null
            }
          />
        </div>
      </Td>
      <Td nowrap>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
      <Td nowrap>
        {progress.required === 0 ? (
          <span className={styles.quiet}>None required</span>
        ) : (
          <div className={styles.rowProgress}>
            <span>
              {progress.accepted} of {progress.required} accepted
            </span>
            <progress aria-hidden="true" value={progress.accepted} max={progress.required} />
          </div>
        )}
      </Td>
      <Td nowrap>
        {c.decidedAt !== null ? (
          <time dateTime={c.decidedAt}>{when(c.decidedAt)}</time>
        ) : (
          <span className={styles.quiet}>Not decided</span>
        )}
      </Td>
    </tr>
  );
}

export default async function VerificationQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const session = await requireStaffSession('/verification');
  const { status: rawStatus } = await searchParams;
  const filter = parseStatusFilter(rawStatus);

  let cases: VerificationCaseDto[] | null = null;
  let total: number | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    const result = await listVerificationCases(session, filter === 'all' ? {} : { status: filter });
    cases = result.items;
    total = result.total;
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }
  const names =
    cases !== null ? await customerNames(session, cases) : new Map<string, CustomerDto>();
  const here = filterHref(filter);

  return (
    <Page>
      <PageHeader
        title="Verification"
        description="Review customer documents and track verification decisions."
      />

      <div className={styles.queue}>
        <TabNav
          label="Filter cases by status"
          activeHref={here}
          items={FILTERS.map(({ value, label }) => ({ href: filterHref(value), label }))}
        />

        {problem !== null ? (
          <Alert
            tone={problem.status === 403 ? 'info' : 'error'}
            role="alert"
            title={
              problem.status === 403
                ? 'Your roles do not include verification'
                : 'The verification queue did not load'
            }
            actions={problem.status !== 403 ? <Link href={here}>Reload the queue</Link> : null}
          >
            {problem.status === 403
              ? 'Verification is for the people who review customer documents. Ask an administrator if you need it.'
              : problem.message}
          </Alert>
        ) : cases !== null && cases.length === 0 ? (
          <EmptyState
            title={
              filter === 'submitted' ? 'No customers are waiting for review.' : 'No cases match.'
            }
            icon="shield-check"
          >
            {filter === 'submitted'
              ? 'A customer appears here when their documents are submitted for verification.'
              : 'Try another status above.'}
          </EmptyState>
        ) : cases !== null ? (
          <Card className={styles.queueResults}>
            <Table caption="Verification cases" minWidth={610} className={styles.queueTable ?? ''}>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Status</Th>
                  <Th>Required documents</Th>
                  <Th>Decided</Th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <Row key={c.id} c={c} customer={names.get(c.partyId)} />
                ))}
              </tbody>
            </Table>
            <p className={styles.resultsFooter}>
              {total !== null && total > cases.length
                ? `Showing the first ${cases.length} of ${total} cases. Filter by status to narrow the list.`
                : `Showing ${cases.length} ${cases.length === 1 ? 'case' : 'cases'}`}
            </p>
          </Card>
        ) : null}
      </div>
    </Page>
  );
}
