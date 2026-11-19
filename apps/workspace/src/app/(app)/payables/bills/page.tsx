import { BILL_STATUSES, BillStatusSchema } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { listBills, type BillListItem } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { when } from '@/lib/kernel-format';

import { poMoney } from '../../procurement/orders/_lib/model';
import { billFailure } from '../_lib/failure';
import { BILL_STATUS_LABEL, MATCH_STATUS_LABEL, billGrants } from '../_lib/model';
import styles from '../payables.module.css';

export const metadata: Metadata = { title: 'Bills · Business OS' };
export const dynamic = 'force-dynamic';

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = typeof params.status === 'string' ? params.status : '';
  const parsed = BillStatusSchema.safeParse(raw);
  const status = parsed.success ? parsed.data : undefined;

  const session = await requireStaffSession('/payables/bills');

  const numberSystems = await getNumberSystems();
  const grants = billGrants(session.roles);

  const header = (
    <PageHeader
      title="Bills"
      description="Vendor invoices keyed in, matched against their purchase orders and receipts, and sent for approval."
      actions={
        grants.enter ? (
          <div className={styles.headActions}>
            <LinkButton href="/payables/bills/new">New bill</LinkButton>
            <LinkButton href="/payables/inbox" variant="secondary">
              Open the inbox
            </LinkButton>
          </div>
        ) : null
      }
    />
  );

  let bills: BillListItem[];
  try {
    bills = await listBills(session, status);
  } catch (err) {
    const f = billFailure(err, 'load');
    return (
      <Page>
        {header}
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open the bills' : 'The bills did not load'}
          actions={f.status !== 403 ? <Link href="/payables/bills">Try again</Link> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  return (
    <Page>
      {header}
      {raw !== '' && status === undefined ? (
        <Alert tone="warning" role="status" title="That is not a bill status">
          The list below shows every bill instead.
        </Alert>
      ) : null}
      <form method="get" action="/payables/bills" role="search" className={styles.filter}>
        <Field label="Status">
          {(control) => (
            <Select name="status" defaultValue={status ?? ''} {...control}>
              <option value="">Every status</option>
              {BILL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {BILL_STATUS_LABEL[s].text}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          Show bills
        </Button>
      </form>
      {bills.length === 0 ? (
        <EmptyState
          title={status === undefined ? 'No bills yet.' : 'No bills with this status.'}
          icon="file-text"
          headingLevel={2}
          action={
            grants.enter && status === undefined ? (
              <LinkButton href="/payables/inbox" variant="secondary">
                Open the inbox
              </LinkButton>
            ) : undefined
          }
        >
          {status === undefined
            ? 'A bill appears here once an invoice from the inbox is keyed in.'
            : 'Choose another status, or show every status.'}
        </EmptyState>
      ) : (
        <Table caption="Vendor bills, newest first" minWidth={900}>
          <thead>
            <tr>
              <Th>Bill</Th>
              <Th>Vendor</Th>
              <Th>Vendor invoice</Th>
              <Th>Invoice date</Th>
              <Th>Status</Th>
              <Th>Match</Th>
              <Th align="end">Payable</Th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => {
              const st = BILL_STATUS_LABEL[b.status];
              const match = MATCH_STATUS_LABEL[b.matchStatus];
              return (
                <tr key={b.id}>
                  <Td>
                    <Link
                      href={`/payables/bills/${encodeURIComponent(b.id)}`}
                      className={styles.name}
                    >
                      {b.number ?? 'Draft bill'}
                    </Link>
                    {b.kind === 'vendor_credit_note' ? (
                      <span className={styles.note}> Credit note</span>
                    ) : null}
                  </Td>
                  <Td>
                    <span className={styles.long}>{b.vendorName}</span>
                  </Td>
                  <Td>
                    <span className={styles.long}>{b.vendorInvoiceNo}</span>
                  </Td>
                  <Td nowrap>
                    <time dateTime={b.invoiceDate}>{when(b.invoiceDate, 'date')}</time>
                  </Td>
                  <Td nowrap>
                    <Badge tone={st.tone}>{st.text}</Badge>
                  </Td>
                  <Td nowrap>
                    <Badge tone={match.tone}>{match.text}</Badge>
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>
                      {poMoney(b.payableTotal, b.currency, numberSystems)}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
