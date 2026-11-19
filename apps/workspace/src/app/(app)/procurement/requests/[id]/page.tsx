import { randomUUID } from 'node:crypto';

import type { ApprovalRequestDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { SuccessNotice } from '@/components/p4/success-notice';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import {
  getPurchaseRequest,
  type LinkedPurchaseOrder,
  type PurchaseRequestDto,
} from '@/lib/api-procurement';
import { getApprovalRequest } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { humanizeKey } from '@/lib/kernel-ui';

import { ApprovalTimeline } from '../../approval-timeline';
import { PO_STATUS_LABEL } from '../../orders/_lib/model';
import layout from '../../procurement.module.css';
import { canStartRfq, rfqGrants } from '../../rfqs/_lib/model';
import { CancelForm, SubmitForm } from '../_components/command-forms';
import { prFailure } from '../_lib/failure';
import {
  canCancelPr,
  isPrEditable,
  PR_STATUS_LABEL,
  PR_STATUS_NOTE,
  prGrants,
  REQUEST_TYPE_LABEL,
} from '../_lib/model';
import styles from '../requests.module.css';

export const metadata: Metadata = { title: 'Purchase request · Business OS' };
export const dynamic = 'force-dynamic';

type ApprovalLoad =
  | { approval: ApprovalRequestDto; problem?: undefined }
  | { approval?: undefined; problem: { message: string; status: number } };

async function loadApproval(
  session: Awaited<ReturnType<typeof requireStaffSession>>,
  approvalRequestId: string,
): Promise<ApprovalLoad> {
  try {
    return { approval: await getApprovalRequest(session, approvalRequestId) };
  } catch (err) {
    const f = prFailure(err, 'load');
    return { problem: { message: f.message, status: f.status } };
  }
}

/** Where the approval stands: the steps the route planned and what each one is doing. */
function ApprovalPanel({ load, retry }: { load: ApprovalLoad; retry: string }) {
  const { approval, problem } = load;
  return (
    <Panel
      title="Approval"
      description="The department head decides this request. An emergency request goes on to Management."
    >
      {problem !== undefined ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role={problem.status === 403 ? 'status' : 'alert'}
          title={
            problem.status === 403
              ? 'Your roles do not include approval details'
              : 'The approval did not load'
          }
          actions={problem.status !== 403 ? <Link href={retry}>Try again</Link> : null}
        >
          {problem.status === 403 ? 'You can still see the request status above.' : problem.message}
        </Alert>
      ) : (
        <>
          <p className={styles.note}>
            Approval {humanizeKey(approval.status).toLowerCase()}
            {approval.decidedAt !== null ? `, decided ${when(approval.decidedAt)}` : ''}.
          </p>
          {approval.steps.length === 0 ? (
            <p className={styles.note}>No approval steps were planned.</p>
          ) : (
            <ApprovalTimeline steps={approval.steps} />
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * The orders raised from this request, with what the request's reader may do on each: open its receipts, and
 * record a service receipt when the API says they may (U18 #4). The requester holds no purchase order read, so
 * the order is named here and its receipts open by the order's id.
 */
function OrdersPanel({ orders }: { orders: readonly LinkedPurchaseOrder[] }) {
  return (
    <Panel
      title="Purchase orders"
      description="Orders raised from this request. Open one to see what has been received."
    >
      <Table
        className={layout.panelTable ?? ''}
        caption="Purchase orders of this request"
        minWidth={640}
      >
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>Vendor</Th>
            <Th>Status</Th>
            <Th>
              <span className={styles.srOnly}>Receive</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const status = PO_STATUS_LABEL[o.status];
            return (
              <tr key={o.id}>
                <Td nowrap>
                  <Link href={`/procurement/receipts?po=${encodeURIComponent(o.id)}`}>
                    {o.number}
                  </Link>
                </Td>
                <Td>
                  <span className={styles.long}>{o.vendorName}</span>
                </Td>
                <Td nowrap>
                  <Badge tone={status.tone}>{status.text}</Badge>
                </Td>
                <Td align="end" nowrap>
                  {o.can.receiveService ? (
                    <LinkButton
                      href={`/procurement/receipts/new?po=${encodeURIComponent(o.id)}`}
                      variant="secondary"
                      size="small"
                      aria-label={`Receive service on ${o.number}`}
                    >
                      Receive service
                    </LinkButton>
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Panel>
  );
}

function factsOf(pr: PurchaseRequestDto): Fact[] {
  return [
    { key: 'type', label: 'Type', value: REQUEST_TYPE_LABEL[pr.requestType] },
    { key: 'needed', label: 'Needed by', value: when(pr.requiredBy, 'date') },
    {
      key: 'dept',
      label: 'Department',
      value: pr.departmentName ?? (
        <span className={styles.numeric}>Department name unavailable</span>
      ),
    },
    {
      key: 'cost',
      label: 'Cost centre',
      value: pr.costCenterName ?? (
        <span className={styles.numeric}>Cost centre name unavailable</span>
      ),
    },
    { key: 'budget', label: 'Budget code', value: pr.budgetCode },
    { key: 'currency', label: 'Currency', value: pr.currency },
    {
      key: 'delivery',
      label: 'Delivery location',
      value: pr.deliveryLocation ?? <span className={styles.quiet}>Not set</span>,
    },
    {
      key: 'project',
      label: 'Project',
      value:
        pr.projectId !== null ? (
          <span className={styles.numeric}>Project name unavailable</span>
        ) : (
          <span className={styles.quiet}>None</span>
        ),
    },
    {
      key: 'submitted',
      label: 'Submitted',
      value:
        pr.submittedAt !== null ? (
          when(pr.submittedAt)
        ) : (
          <span className={styles.quiet}>Not submitted yet</span>
        ),
    },
    {
      key: 'why',
      label: 'Why it is needed',
      value: <span className={styles.long}>{pr.justification}</span>,
      wide: true,
    },
    ...(pr.isEmergency
      ? [
          {
            key: 'emergency',
            label: 'Emergency reason',
            value: <span className={styles.long}>{pr.emergencyReason ?? 'Not given'}</span>,
            wide: true,
          },
        ]
      : []),
  ];
}

export default async function PurchaseRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string | string[]; saved?: string | string[] }>;
}) {
  const { id } = await params;
  if (!isGuid(id)) notFound();
  const session = await requireStaffSession(`/procurement/requests/${id}`);
  const numberSystems = await getNumberSystems();
  const sp = await searchParams;
  const self = `/procurement/requests/${encodeURIComponent(id)}`;

  let pr: PurchaseRequestDto;
  try {
    pr = await getPurchaseRequest(session, id);
  } catch (err) {
    const f = prFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page>
        <Breadcrumb
          items={[
            { label: 'Purchase requests', href: '/procurement/requests' },
            { label: 'Request' },
          ]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            f.status === 403
              ? 'Your roles do not include this purchase request'
              : 'The purchase request did not load'
          }
          actions={f.status !== 403 ? <Link href={self}>Try again</Link> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const approvalLoad =
    pr.approvalRequestId !== null ? await loadApproval(session, pr.approvalRequestId) : null;
  const grants = prGrants(session.roles);
  const status = PR_STATUS_LABEL[pr.status];
  const editable = isPrEditable(pr.status) && grants.create;
  const showFx = pr.currency !== 'NPR' && pr.estimatedTotalNpr !== null;
  const label = pr.number ?? 'Draft purchase request';

  return (
    <Page className={layout.detail}>
      <div className={layout.detailHeader}>
        <Breadcrumb
          items={[{ label: 'Purchase requests', href: '/procurement/requests' }, { label }]}
        />
        <PageHeader
          title={label}
          status={
            <span className={styles.badges}>
              <Badge tone={status.tone}>{status.text}</Badge>
              {pr.isEmergency ? <Badge tone="error">Emergency</Badge> : null}
            </span>
          }
          description={PR_STATUS_NOTE[pr.status]}
          actions={
            <>
              {editable ? (
                <LinkButton href={`${self}/edit`} variant="secondary">
                  Edit request
                </LinkButton>
              ) : null}
              {pr.rfqId && rfqGrants(session.roles).sourcing ? (
                <LinkButton href={`/procurement/rfqs/${encodeURIComponent(pr.rfqId)}`}>
                  Open RFQ
                </LinkButton>
              ) : canStartRfq(pr.status, pr.rfqId, session.roles) ? (
                <LinkButton href={`/procurement/rfqs/new?pr=${encodeURIComponent(pr.id)}`}>
                  Start RFQ
                </LinkButton>
              ) : null}
            </>
          }
        />
      </div>

      {sp.created !== undefined ? (
        <SuccessNotice message="The draft was saved." />
      ) : sp.saved !== undefined ? (
        <SuccessNotice message="Your changes were saved." />
      ) : null}

      <div className={editable || approvalLoad !== null ? layout.detailColumns : layout.stack}>
        <Panel title="Request details">
          <FactList facts={factsOf(pr)} />
        </Panel>
        {editable || approvalLoad !== null ? (
          <div className={layout.stack}>
            {editable ? (
              <Panel
                as="aside"
                title={pr.status === 'returned' ? 'Resubmit' : 'Submit for approval'}
              >
                <SubmitForm
                  prId={pr.id}
                  version={pr.version}
                  idempotencyKey={randomUUID()}
                  emergency={pr.isEmergency}
                  reloadHref={self}
                />
              </Panel>
            ) : null}

            {approvalLoad !== null ? <ApprovalPanel load={approvalLoad} retry={self} /> : null}

            {canCancelPr(pr.status) && grants.create ? (
              <Panel as="aside" title="Cancel">
                <CancelForm
                  prId={pr.id}
                  version={pr.version}
                  idempotencyKey={randomUUID()}
                  reloadHref={self}
                />
              </Panel>
            ) : null}
          </div>
        ) : null}
      </div>

      {pr.purchaseOrders !== undefined && pr.purchaseOrders.length > 0 ? (
        <OrdersPanel orders={pr.purchaseOrders} />
      ) : null}

      <Panel
        title="Line items"
        description="Estimates entered with the request. The totals are the platform's."
      >
        <Table className={layout.panelTable ?? ''} caption="Purchase request lines" minWidth={640}>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Item</Th>
              <Th align="end">Quantity</Th>
              <Th align="end">Estimated unit price</Th>
              <Th align="end">Estimated amount</Th>
            </tr>
          </thead>
          <tbody>
            {pr.lines.map((l) => (
              <tr key={l.id}>
                <Td nowrap>{l.lineNo}</Td>
                <Td>
                  <CellTitle
                    title={<span className={styles.long}>{l.description}</span>}
                    meta={
                      l.specification !== null ? (
                        <span className={styles.long}>{l.specification}</span>
                      ) : null
                    }
                  />
                </Td>
                <Td align="end" nowrap>
                  <span className={styles.numeric}>
                    {l.quantity} {l.uom}
                  </span>
                </Td>
                <Td align="end" nowrap>
                  <span className={styles.numeric}>
                    {money(l.estimatedUnitPrice, pr.currency, numberSystems)}
                  </span>
                </Td>
                <Td align="end" nowrap>
                  <span className={styles.numeric}>
                    {money(l.estimatedAmount, pr.currency, numberSystems)}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <FactList
          className={layout.totals ?? ''}
          facts={[
            {
              key: 'total',
              label: `Estimated total (${pr.currency})`,
              value: (
                <strong className={styles.numeric}>
                  {money(pr.estimatedTotal, pr.currency, numberSystems)}
                </strong>
              ),
            },
            ...(showFx && pr.estimatedTotalNpr !== null
              ? [
                  {
                    key: 'npr',
                    label: 'Estimated total in NPR',
                    value: (
                      <span className={styles.numeric}>
                        {money(pr.estimatedTotalNpr, 'NPR', numberSystems)}
                        {pr.fxRate !== null ? (
                          <span className={styles.quiet}>
                            {' '}
                            at {pr.fxRate}
                            {pr.fxDate !== null ? `, rate of ${pr.fxDate}` : ''}
                          </span>
                        ) : null}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Panel>
    </Page>
  );
}
