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
import { Table, Td, Th } from '@/components/ui/table';
import { getApprovalRequest } from '@/lib/api-kernel';
import { getPurchaseRequest } from '@/lib/api-procurement';
import { getComparison, getRfq, listSubmissions, type RfqDto } from '@/lib/api-rfqs';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { humanizeKey } from '@/lib/kernel-ui';
import { getPermissionCheck } from '@/lib/live-permissions';

import { qtyText } from '../../orders/_lib/model';
import { ApprovalActions } from '../../approval-actions';
import { ApprovalTimeline } from '../../approval-timeline';
import layout from '../../procurement.module.css';
import styles from '../../requests/requests.module.css';
import {
  CommitForm,
  ExtendDeadlineForm,
  RecommendForm,
  ScoreForm,
} from '../_components/decision-forms';
import {
  commitRfqAction,
  extendDeadlineAction,
  recommendQuotationAction,
  scoreQuotationAction,
} from '../actions';
import { rfqFailure } from '../_lib/failure';
import {
  arrivedLate,
  canCommit,
  canExtendDeadline,
  deadlinePassed,
  RFQ_STATUS_LABEL,
  RFQ_STATUS_NOTE,
  rfqGrants,
  submissionConvertibility,
  takesDecisions,
  takesQuotations,
} from '../_lib/model';

export const metadata: Metadata = { title: 'RFQ · Business OS' };
export const dynamic = 'force-dynamic';

type Problem = { message: string; status: number };
type Load<T> = { value: T; problem?: undefined } | { value?: undefined; problem: Problem };

async function attempt<T>(run: () => Promise<T>): Promise<Load<T>> {
  try {
    return { value: await run() };
  } catch (err) {
    const f = rfqFailure(err, 'load');
    return { problem: { message: f.message, status: f.status } };
  }
}

function Degraded({ what, problem, retry }: { what: string; problem: Problem; retry: string }) {
  const forbidden = problem.status === 403;
  return (
    <Alert
      tone={forbidden ? 'info' : 'error'}
      role={forbidden ? 'status' : 'alert'}
      title={forbidden ? `Your roles do not include ${what}` : `${what} did not load`}
      actions={!forbidden ? <Link href={retry}>Try again</Link> : null}
    >
      {problem.message}
    </Alert>
  );
}

/** Where the commitment approval stands: the steps the route planned and what each one is doing. */
function ApprovalPanel({ load, retry }: { load: Load<ApprovalRequestDto>; retry: string }) {
  const approval = load.value;
  return (
    <Panel
      title="Commitment approval"
      description="Accountant, then Finance, then Management or the Founder when the amount is high."
    >
      {approval === undefined ? (
        <Degraded what="The approval" problem={load.problem} retry={retry} />
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
          <ApprovalActions actions={approval.actions} people={approval.people} />
        </>
      )}
    </Panel>
  );
}

export default async function RfqPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    created?: string | string[];
    quoted?: string | string[];
    recommended?: string | string[];
  }>;
}) {
  const { id } = await params;
  if (!isGuid(id)) notFound();
  const session = await requireStaffSession(`/procurement/rfqs/${id}`);
  const numberSystems = await getNumberSystems();
  const sp = await searchParams;
  const self = `/procurement/rfqs/${encodeURIComponent(id)}`;

  let rfq: RfqDto;
  try {
    rfq = await getRfq(session, id);
  } catch (err) {
    const f = rfqFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page>
        <Breadcrumb
          items={[{ label: 'Requests for quotation', href: '/procurement/rfqs' }, { label: 'RFQ' }]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'Your roles do not include sourcing' : 'The RFQ did not load'}
          actions={f.status !== 403 ? <Link href={self}>Try again</Link> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const allowed = await getPermissionCheck(session);
  const grants = rfqGrants(allowed);
  const open = takesQuotations(rfq.status);
  // F1-Q47: after the deadline an open RFQ takes no quotation until Procurement extends it.
  const passed = deadlinePassed(rfq.deadline, new Date());
  const entersQuotations = grants.sourcing && open && !passed;
  const extend = canExtendDeadline(rfq.status, allowed);
  const [comparison, submissions, pr, approval] = await Promise.all([
    attempt(() => getComparison(session, id)),
    grants.sourcing && open ? attempt(() => listSubmissions(session, id)) : Promise.resolve(null),
    attempt(() => getPurchaseRequest(session, rfq.purchaseRequestId)),
    rfq.commitmentApprovalRequestId !== null
      ? attempt(() => getApprovalRequest(session, rfq.commitmentApprovalRequestId as string))
      : Promise.resolve(null),
  ]);
  // The names come with the RFQ and its quotations, under the RFQ's own grant: no vendor directory read.
  const names = new Map([
    ...rfq.vendors.map((v) => [v.id, v.name] as const),
    ...(comparison.value ?? []).map((q) => [q.vendorId, q.vendorName] as const),
  ]);
  const vendorLabel = (vendorId: string): string => names.get(vendorId) ?? 'Invited vendor';
  const status = RFQ_STATUS_LABEL[rfq.status];
  const prNumber = pr.value?.number ?? null;
  const decide = grants.sourcing && takesDecisions(rfq.status);
  const quotations = comparison.value ?? [];
  const commit = canCommit(
    {
      status: rfq.status,
      recommendedQuotationId: rfq.recommendedQuotationId,
      prStatus: pr.value?.status ?? null,
    },
    allowed,
  );

  const facts: Fact[] = [
    {
      key: 'pr',
      label: 'Purchase request',
      value: (
        <Link
          href={`/procurement/requests/${encodeURIComponent(rfq.purchaseRequestId)}`}
          className={styles.numeric}
        >
          {prNumber ?? 'Open purchase request'}
        </Link>
      ),
    },
    {
      key: 'deadline',
      label: 'Quotation deadline',
      value: open && passed ? `${when(rfq.deadline)} (passed)` : when(rfq.deadline),
    },
    {
      key: 'vendors',
      label: `Invited vendors (${rfq.vendorIds.length})`,
      value: (
        <span className={styles.long}>{rfq.vendorIds.map(vendorLabel).join(', ') || 'None'}</span>
      ),
      wide: true,
    },
    ...(rfq.recommendedQuotationId !== null
      ? [
          {
            key: 'recommended',
            label: 'Recommended quotation',
            value: (
              <span className={styles.long}>
                {(() => {
                  const row = comparison.value?.find((q) => q.id === rfq.recommendedQuotationId);
                  return row !== undefined
                    ? `${vendorLabel(row.vendorId)}, ${money(row.total, row.currency, numberSystems)}`
                    : 'Recommended quotation';
                })()}
              </span>
            ),
            wide: true,
          },
          {
            key: 'why',
            label: 'Why this one',
            value: (
              <span className={styles.long}>{rfq.recommendationRationale ?? 'Not given'}</span>
            ),
            wide: true,
          },
          ...(rfq.fewerThanThreeReason !== null
            ? [
                {
                  key: 'few',
                  label: 'Why fewer quotations',
                  value: <span className={styles.long}>{rfq.fewerThanThreeReason}</span>,
                  wide: true,
                },
              ]
            : []),
        ]
      : []),
  ];

  return (
    <Page className={layout.detail}>
      <div className={layout.detailHeader}>
        <Breadcrumb
          items={[
            { label: 'Requests for quotation', href: '/procurement/rfqs' },
            { label: rfq.number },
          ]}
        />
        <PageHeader
          title={rfq.number}
          status={<Badge tone={status.tone}>{status.text}</Badge>}
          description={RFQ_STATUS_NOTE[rfq.status]}
          actions={
            entersQuotations || extend || commit.show ? (
              <>
                {entersQuotations ? (
                  <LinkButton href={`${self}/quotations/new`}>Enter a quotation</LinkButton>
                ) : null}
                {extend ? (
                  <ExtendDeadlineForm
                    action={extendDeadlineAction}
                    idempotencyKey={randomUUID()}
                    rfqId={rfq.id}
                    deadline={rfq.deadline}
                    deadlineText={when(rfq.deadline)}
                    passed={passed}
                    reloadHref={self}
                  />
                ) : null}
                {commit.show ? (
                  <CommitForm
                    action={commitRfqAction}
                    idempotencyKey={randomUUID()}
                    rfqId={rfq.id}
                    reloadHref={self}
                  />
                ) : null}
              </>
            ) : null
          }
        />
      </div>

      {sp.created !== undefined ? (
        <SuccessNotice message="The RFQ was opened and the purchase request moved to sourcing." />
      ) : sp.quoted !== undefined ? (
        <SuccessNotice message="The quotation was recorded." />
      ) : sp.recommended !== undefined ? (
        <SuccessNotice message="The quotation was recommended." />
      ) : null}

      {open && passed ? (
        <Alert tone="warning" role="status" title="The quotation deadline has passed">
          No more quotations are taken since {when(rfq.deadline)}.{' '}
          {extend
            ? 'Recommend one of the quotations received, or extend the deadline to take more.'
            : 'A quotation already received can still be recommended.'}
        </Alert>
      ) : null}

      <section aria-label="RFQ" className={layout.detailColumns}>
        <Panel title="Request details">
          <FactList facts={facts.filter((fact) => fact.key !== 'pr')} />
        </Panel>
        <div className={layout.stack}>
          <Panel as="aside" title="Linked records" className={layout.linkedRecords}>
            <FactList facts={facts.filter((fact) => fact.key === 'pr')} />
          </Panel>
          {commit.why !== undefined ? (
            <Alert tone="warning" role="status" title="Commitment cannot be submitted yet">
              {commit.why}
            </Alert>
          ) : null}
          {approval !== null ? <ApprovalPanel load={approval} retry={self} /> : null}
        </div>
      </section>

      <Panel
        title="Quotations"
        description="Cheapest first, by total in NPR. Every figure is the platform's."
      >
        {comparison.value === undefined ? (
          <Degraded what="Quotations" problem={comparison.problem} retry={self} />
        ) : comparison.value.length === 0 ? (
          <p className={styles.note}>
            No quotation has been recorded yet.
            {entersQuotations
              ? ' Enter one from a vendor’s document, or convert a vendor submission.'
              : ''}
          </p>
        ) : (
          <Table className={layout.panelTable ?? ''} caption="Quotations received" minWidth={720}>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th align="end">Total</Th>
                <Th align="end">Total in NPR</Th>
                <Th align="end">Delivery</Th>
                <Th align="end">Score</Th>
              </tr>
            </thead>
            <tbody>
              {comparison.value.map((q) => (
                <tr key={q.id}>
                  <Td>
                    <span className={styles.badges}>
                      <span className={styles.name}>{vendorLabel(q.vendorId)}</span>
                      {q.id === rfq.recommendedQuotationId ? (
                        <Badge tone="success">Recommended</Badge>
                      ) : null}
                    </span>
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>
                      {money(q.total, q.currency, numberSystems)}
                    </span>
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>
                      {money(q.totalNpr, 'NPR', numberSystems)}
                    </span>
                    {q.currency !== 'NPR' ? (
                      <span className={styles.quiet}> at {q.fxRate}</span>
                    ) : null}
                  </Td>
                  <Td align="end" nowrap>
                    {q.deliveryDays !== null ? (
                      `${q.deliveryDays} days`
                    ) : (
                      <span className={styles.quiet}>Not stated</span>
                    )}
                  </Td>
                  <Td align="end" nowrap>
                    {q.averageScore !== null ? (
                      <span className={styles.numeric}>{q.averageScore}</span>
                    ) : (
                      <span className={styles.quiet}>Not scored</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      {quotations.length > 0 ? (
        <Panel
          title="What each vendor quoted"
          description="Line by line, as recorded from the vendor's document. The gross, tax and line total are the platform's, and they add up to the totals above."
        >
          <div className={styles.panelForm}>
            {quotations.map((q) => (
              <Table
                key={q.id}
                className={layout.panelTable ?? ''}
                caption={`Lines quoted by ${vendorLabel(q.vendorId)}`}
                minWidth={760}
              >
                <thead>
                  <tr>
                    <Th align="end">#</Th>
                    <Th>Item</Th>
                    <Th align="end">Quantity</Th>
                    <Th align="end">Unit price</Th>
                    <Th align="end">Gross</Th>
                    <Th align="end">Tax</Th>
                    <Th align="end">Line total</Th>
                  </tr>
                </thead>
                <tbody>
                  {q.lines.map((l) => (
                    <tr key={l.id}>
                      <Td align="end" nowrap>
                        {l.lineNo}
                      </Td>
                      <Td>
                        <span className={styles.name}>{l.description}</span>
                      </Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>{qtyText(l.quantity)}</span>
                      </Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>
                          {money(l.unitPrice, q.currency, numberSystems)}
                        </span>
                      </Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>
                          {money(l.gross, q.currency, numberSystems)}
                        </span>
                      </Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>
                          {money(l.taxAmount, q.currency, numberSystems)}
                        </span>
                        <span className={styles.quiet}> {l.taxCode}</span>
                      </Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>
                          {money(l.lineTotal, q.currency, numberSystems)}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <Td colSpan={4}>
                      <strong>{vendorLabel(q.vendorId)} total</strong>
                    </Td>
                    <Td align="end" nowrap>
                      <span className={styles.numeric}>
                        {money(q.subtotal, q.currency, numberSystems)}
                      </span>
                    </Td>
                    <Td align="end" nowrap>
                      <span className={styles.numeric}>
                        {money(q.taxAmount, q.currency, numberSystems)}
                      </span>
                    </Td>
                    <Td align="end" nowrap>
                      <span className={styles.numeric}>
                        {money(q.total, q.currency, numberSystems)}
                      </span>
                    </Td>
                  </tr>
                </tfoot>
              </Table>
            ))}
          </div>
        </Panel>
      ) : null}

      {decide && quotations.length > 0 ? (
        <>
          <Panel
            title="Score the quotations"
            description="Mark each quotation from 0 to 100 against the criteria you choose. The average above is the platform’s."
          >
            <div className={styles.panelForm}>
              {quotations.map((q) => (
                <ScoreForm
                  key={q.id}
                  action={scoreQuotationAction}
                  idempotencyKey={randomUUID()}
                  rfqId={rfq.id}
                  quotationId={q.id}
                  vendorName={vendorLabel(q.vendorId)}
                  held={q.scores.map((s) => ({ criterion: s.criterion, score: s.score }))}
                  reloadHref={self}
                />
              ))}
            </div>
          </Panel>
          <Panel
            title="Recommend a quotation"
            description="Choose the quotation to take to the commitment approvers and say why."
          >
            <RecommendForm
              action={recommendQuotationAction}
              idempotencyKey={randomUUID()}
              rfqId={rfq.id}
              choices={quotations.map((q) => ({
                id: q.id,
                label: `${vendorLabel(q.vendorId)}, ${money(q.total, q.currency, numberSystems)}`,
              }))}
              reloadHref={self}
            />
          </Panel>
        </>
      ) : null}

      {submissions !== null ? (
        <Panel
          title="Vendor submissions"
          description="Quotations vendors uploaded in the portal. Convert one after its file scan passes."
        >
          {submissions.value === undefined ? (
            <Degraded what="Vendor submissions" problem={submissions.problem} retry={self} />
          ) : submissions.value.length === 0 ? (
            <p className={styles.note}>No vendor has uploaded a quotation for this RFQ.</p>
          ) : (
            <Table
              className={layout.panelTable ?? ''}
              caption="Vendor submissions waiting to be converted"
              minWidth={640}
            >
              <thead>
                <tr>
                  <Th>Vendor</Th>
                  <Th>Their reference</Th>
                  <Th>Sent</Th>
                  <Th>File</Th>
                  <Th>
                    <span className="sr-only">Action</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {submissions.value.map((s) => {
                  const c = submissionConvertibility(
                    s.scanStatus,
                    arrivedLate(s.submittedAt, rfq.deadline),
                  );
                  return (
                    <tr key={s.id}>
                      <Td>
                        <span className={styles.name}>{s.vendorName}</span>
                      </Td>
                      <Td>
                        <span className={styles.long}>
                          {s.vendorRef ?? <span className={styles.quiet}>None</span>}
                        </span>
                      </Td>
                      <Td nowrap>{when(s.submittedAt)}</Td>
                      <Td>
                        <Badge tone={c.tone}>{c.label}</Badge>
                        {c.reason !== '' ? <p className={styles.note}>{c.reason}</p> : null}
                      </Td>
                      <Td nowrap>
                        {c.convertible ? (
                          <LinkButton
                            href={`${self}/quotations/new?submission=${encodeURIComponent(s.id)}`}
                            variant="secondary"
                            aria-label={`Convert the submission from ${s.vendorName}`}
                          >
                            Convert
                          </LinkButton>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>
      ) : null}
    </Page>
  );
}
