import { AGING_BUCKETS, type ArAgingReport, type Currency } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { getAging } from '@/lib/api-receivables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';

import { BUCKET_LABEL, isZeroAmount } from '../_lib/aging';
import layout from '@/components/p3/list.module.css';
import styles from '../receivables.module.css';

export const metadata: Metadata = { title: 'Receivables aging · Business OS' };
export const dynamic = 'force-dynamic';

const HERE = '/receivables/aging';

/** One amount from the server. A zero is drawn quietly so the open buckets stand out. */
function Amount({
  value,
  currency,
  numberSystems,
}: {
  value: string;
  currency: Currency;
  numberSystems: NumberSystems;
}) {
  return (
    <span className={isZeroAmount(value) ? styles.zero : styles.amount}>
      {money(value, currency, numberSystems)}
    </span>
  );
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
      <PageHeader title="Receivables aging" />
      <Alert
        tone={tone}
        role="alert"
        title={title}
        actions={reload ? <Link href={HERE}>Reload the aging report</Link> : null}
      >
        {children}
      </Alert>
    </Page>
  );
}

function AsOf({ date }: { date: string }) {
  return <time dateTime={date}>{when(date, 'date')}</time>;
}

function AgingTable({
  report,
  numberSystems,
}: {
  report: ArAgingReport;
  numberSystems: NumberSystems;
}) {
  return (
    <Table
      caption={`Receivables aging as of ${when(report.asOf, 'date')}`}
      minWidth={1040}
      className={styles.withTotals ?? ''}
    >
      <thead>
        <tr>
          <Th>Customer</Th>
          {AGING_BUCKETS.map((bucket) => (
            <Th key={bucket} align="end">
              {BUCKET_LABEL[bucket]}
            </Th>
          ))}
          <Th align="end">Total open</Th>
        </tr>
      </thead>
      <tbody>
        {report.rows.map((row) => (
          <tr key={`${row.customerId}-${row.currency}`}>
            <Td>
              <div className={styles.customer}>
                <CellTitle
                  title={
                    <Link href={`/receivables/customers/${encodeURIComponent(row.customerId)}`}>
                      {row.customerName}
                    </Link>
                  }
                  meta={row.currency}
                />
              </div>
            </Td>
            {AGING_BUCKETS.map((bucket) => (
              <Td key={bucket} align="end" nowrap>
                <Amount
                  numberSystems={numberSystems}
                  value={row.buckets[bucket]}
                  currency={row.currency}
                />
              </Td>
            ))}
            <Td align="end" nowrap>
              <span className={styles.total}>
                <Amount
                  numberSystems={numberSystems}
                  value={row.totalOpen}
                  currency={row.currency}
                />
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
      {report.totals.length > 0 ? (
        <tfoot>
          {report.totals.map((total) => (
            <tr key={total.currency}>
              <Th scope="row">Total {total.currency}</Th>
              {AGING_BUCKETS.map((bucket) => (
                <Td key={bucket} align="end" nowrap>
                  <Amount
                    numberSystems={numberSystems}
                    value={total.buckets[bucket]}
                    currency={total.currency}
                  />
                </Td>
              ))}
              <Td align="end" nowrap>
                <span className={styles.total}>
                  <Amount
                    numberSystems={numberSystems}
                    value={total.totalOpen}
                    currency={total.currency}
                  />
                </span>
              </Td>
            </tr>
          ))}
        </tfoot>
      ) : null}
    </Table>
  );
}

export default async function ReceivablesAgingPage() {
  const session = await requireStaffSession(HERE);
  const numberSystems = await getNumberSystems();

  // A person without ar.read is told so without the page fetching anything for them.
  if (!hasPermission(session.roles, 'ar.read')) {
    return (
      <Notice tone="info" title="Your roles do not include receivables">
        Receivables are for the accounts and finance team. Ask an administrator if you need access.
      </Notice>
    );
  }

  let report: ArAgingReport;
  try {
    report = await getAging(session);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 403) {
      return (
        <Notice tone="info" title="Your roles do not include receivables">
          Receivables are for the accounts and finance team. Ask an administrator if you need
          access.
        </Notice>
      );
    }
    return (
      <Notice title="The aging report did not load" reload>
        {f.message}
      </Notice>
    );
  }

  const empty = report.rows.length === 0 && report.totals.length === 0;

  return (
    <Page>
      <PageHeader
        title="Receivables aging"
        description={
          <>
            Open balances by customer and days past due as of <AsOf date={report.asOf} />.
          </>
        }
      />
      {report.totals.length > 0 && (
        <section aria-label="Outstanding balances by currency" className={layout.stats}>
          {report.totals.map((total) => (
            <StatCard
              key={total.currency}
              label={`Open balance · ${total.currency}`}
              icon="banknote"
              value={money(total.totalOpen, total.currency, numberSystems)}
            />
          ))}
        </section>
      )}
      {empty ? (
        <EmptyState icon="banknote" title="No open receivables.">
          Nothing was owed as of <AsOf date={report.asOf} />. An invoice appears here once it is
          issued and not yet fully paid.
        </EmptyState>
      ) : (
        <AgingTable numberSystems={numberSystems} report={report} />
      )}
    </Page>
  );
}
