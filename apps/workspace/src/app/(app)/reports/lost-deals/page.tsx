import type { LostReasonReport } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';

import { getLostReasonReport } from './load';

export const metadata: Metadata = { title: 'Lost deals · Business OS' };
export const dynamic = 'force-dynamic';

const HERE = '/reports/lost-deals';
const TITLE = 'Lost deals';

const MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `2026-11` as "Nov 2026". */
function monthLabel(month: string): string {
  return MONTH.format(new Date(`${month}-01T00:00:00Z`));
}

function Notice({
  tone = 'error',
  title,
  children,
  reload = false,
}: {
  tone?: 'error' | 'info';
  title: string;
  children: string;
  reload?: boolean;
}) {
  return (
    <Page>
      <PageHeader title={TITLE} />
      <Alert
        tone={tone}
        role="alert"
        title={title}
        actions={reload ? <Link href={HERE}>Reload lost deals</Link> : null}
      >
        {children}
      </Alert>
    </Page>
  );
}

function NoAccess() {
  return (
    <Notice tone="info" title="Your roles do not include opportunities">
      Ask an administrator if you need access to deals.
    </Notice>
  );
}

function LostReasonTable({ report }: { report: LostReasonReport }) {
  return (
    <Table
      caption={`Lost deals by reason, ${monthLabel(report.from)} to ${monthLabel(report.to)}`}
      minWidth={Math.max(560, 200 + report.months.length * 80)}
    >
      <thead>
        <tr>
          <Th>Reason</Th>
          {report.months.map((month) => (
            <Th key={month} align="end">
              {monthLabel(month)}
            </Th>
          ))}
          <Th align="end">Total</Th>
        </tr>
      </thead>
      <tbody>
        {report.rows.map((row) => (
          <tr key={row.reason?.id ?? 'none'}>
            <Td>
              {row.reason === null
                ? 'No reason given'
                : row.reason.retired
                  ? `${row.reason.label} (retired)`
                  : row.reason.label}
            </Td>
            {row.counts.map((count, i) => (
              <Td key={report.months[i]} align="end">
                {count}
              </Td>
            ))}
            <Td align="end">{row.total}</Td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <Th scope="row">Total</Th>
          {report.monthTotals.map((count, i) => (
            <Td key={report.months[i]} align="end">
              {count}
            </Td>
          ))}
          <Td align="end">{report.total}</Td>
        </tr>
      </tfoot>
    </Table>
  );
}

export default async function LostDealsPage() {
  const session = await requireStaffSession(HERE);

  // The live grants decide (Settings > Access); the API checks again and counts only deals the person may open.
  if (!(await getPermissionCheck(session))('crm.opportunity.read')) return <NoAccess />;

  let report: LostReasonReport;
  try {
    report = await getLostReasonReport(session);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 403) return <NoAccess />;
    return (
      <Notice title="Lost deals did not load" reload>
        {f.message}
      </Notice>
    );
  }

  return (
    <Page>
      <PageHeader
        title={TITLE}
        description={`Deals marked lost, by reason and month, ${monthLabel(report.from)} to ${monthLabel(report.to)}.`}
      />
      {report.total === 0 ? (
        <EmptyState icon="trending-up" title="No lost deals in this period.">
          A deal appears here once it is marked lost.
        </EmptyState>
      ) : (
        <LostReasonTable report={report} />
      )}
    </Page>
  );
}
