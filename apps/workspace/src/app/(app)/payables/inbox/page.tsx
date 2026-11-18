import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listBillSubmissions, type BillSubmission } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { RejectDialog } from '../_components/bill-actions';
import { billFailure } from '../_lib/failure';
import { billGrants, fileStatusLabel } from '../_lib/model';
import styles from '../payables.module.css';

export const metadata: Metadata = { title: 'Bill inbox · Business OS' };
export const dynamic = 'force-dynamic';

/** Why a row cannot become a bill yet, or undefined when it can. */
function blocker(s: BillSubmission): string | undefined {
  if (s.fileStatus === 'infected' || s.fileStatus === 'failed') {
    return 'The file failed its scan. Reject this submission';
  }
  if (s.fileStatus !== 'clean') return 'Waiting for the file scan to pass';
  if (s.vendorPartyId === null) return 'The vendor is not named';
  if (s.vendorInvoiceNo === null || s.invoiceDate === null)
    return 'The invoice details are missing';
  return undefined;
}

export default async function BillInboxPage() {
  const session = await requireStaffSession('/payables/inbox');
  const grants = billGrants(session.roles);

  const header = (
    <PageHeader
      title="Bill inbox"
      description="Invoices vendors sent through the portal, oldest first. Key one in to make a bill, or reject it with a reason."
      actions={
        <LinkButton href="/payables/bills" variant="secondary">
          Open the bills
        </LinkButton>
      }
    />
  );

  let rows: BillSubmission[];
  try {
    rows = await listBillSubmissions(session);
  } catch (err) {
    const f = billFailure(err, 'load');
    return (
      <Page>
        {header}
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open the inbox' : 'The inbox did not load'}
          actions={f.status !== 403 ? <a href="/payables/inbox">Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  return (
    <Page>
      {header}
      <Panel title="Waiting for a bill" actions={<Badge tone="neutral">{rows.length}</Badge>}>
        {rows.length === 0 ? (
          <EmptyState title="The inbox is empty." icon="check-circle" headingLevel={3}>
            When a vendor sends an invoice through the portal, it appears here.
          </EmptyState>
        ) : (
          <Table caption="Vendor invoice submissions, oldest first" minWidth={980}>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th>Invoice</Th>
                <Th>Invoice date</Th>
                <Th>Order</Th>
                <Th>File</Th>
                <Th>Received</Th>
                <Th align="end">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const file = fileStatusLabel(s.fileStatus);
                const why = blocker(s);
                const label = s.vendorInvoiceNo ?? 'this submission';
                return (
                  <tr key={s.id}>
                    <Td>
                      {s.vendorName !== null ? (
                        <span className={styles.name}>{s.vendorName}</span>
                      ) : (
                        <span className={styles.quiet}>Not named</span>
                      )}
                      {s.note !== null ? <span className={styles.rowNote}>{s.note}</span> : null}
                    </Td>
                    <Td>
                      {s.vendorInvoiceNo !== null ? (
                        <span className={styles.long}>{s.vendorInvoiceNo}</span>
                      ) : (
                        <span className={styles.quiet}>Missing</span>
                      )}
                    </Td>
                    <Td nowrap>
                      {s.invoiceDate !== null ? (
                        <time dateTime={s.invoiceDate}>{when(s.invoiceDate, 'date')}</time>
                      ) : (
                        <span className={styles.quiet}>Missing</span>
                      )}
                    </Td>
                    <Td nowrap>
                      {s.purchaseOrderId !== null ? (
                        'Against an order'
                      ) : (
                        <span className={styles.quiet}>No order</span>
                      )}
                    </Td>
                    <Td nowrap>
                      <Badge tone={file.tone}>{file.text}</Badge>
                    </Td>
                    <Td nowrap>
                      <time dateTime={s.receivedAt}>{when(s.receivedAt)}</time>
                    </Td>
                    <Td align="end">
                      {grants.enter ? (
                        <div className={styles.rowActions}>
                          {why === undefined ? (
                            <LinkButton
                              href={`/payables/bills/new?submission=${encodeURIComponent(s.id)}`}
                              variant="primary"
                            >
                              Create bill
                            </LinkButton>
                          ) : (
                            <span className={styles.note}>{why}</span>
                          )}
                          <RejectDialog
                            targetId={s.id}
                            label={label}
                            idempotencyKey={randomUUID()}
                            reloadHref="/payables/inbox"
                          />
                        </div>
                      ) : (
                        <span className={styles.note}>Accountants handle the inbox</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}
