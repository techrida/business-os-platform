import type { LeadLostReason, OpportunityDto, QuotationListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { NumberSystems } from '@bos/locale';

import { getOpportunity, listActivities } from '@/components/p2/crm/crm-api';
import { FollowUpsCard } from '@/components/p2/crm/follow-ups-card';
import { moneyOrNull } from '@/components/p2/crm/format';
import { MarkLostDialog } from '@/components/p2/crm/mark-lost-dialog';
import { canAssignFollowUps, loadPeople } from '@/components/p2/crm/people';
import { PutOnHoldDialog } from '@/components/p2/crm/put-on-hold-dialog';
import { ActivityList, LoadProblem, StageBadge } from '@/components/p2/crm/server-bits';
import { StageConfirmDialog } from '@/components/p2/crm/stage-confirm-dialog';
import {
  resolvedMoves,
  resumeMove,
  stageLabel,
  stagesBefore,
  type Move,
} from '@/components/p2/crm/stages';
import { listQuotations } from '@/components/p2/quotations/api';
import {
  editQuotationHref,
  newQuotationHref,
  opportunityQuotationsHref,
  quotationEntryFor,
  type QuotationEntry,
} from '@/components/p2/quotations/resume';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { StatusTimeline, type TimelineStep } from '@/components/ui/status-timeline';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { listOpportunityLostReasonChoices } from '@/lib/api-lead-lost-reasons';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { getMeOrNull, getPermissionCheck } from '@/lib/live-permissions';
import { getCustomer } from '@/components/p2/customers/api';

import { moveOpportunityStageAction } from '../actions';
import { OpportunityActivities } from './activity-panel';
import styles from './detail.module.css';

export const metadata: Metadata = { title: 'Opportunity · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LINEAR_STAGES = [
  'qualified',
  'requirement_received',
  'proposal_sent',
  'quotation_sent',
  'negotiation',
  'won',
] as const;

interface PrimaryStageAction {
  stage: string;
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  successMessage: string;
  errorMessage: string;
}

function primaryOpportunityMove(
  opp: Pick<OpportunityDto, 'stage' | 'number'>,
  moves: readonly Move[],
): PrimaryStageAction | null {
  const has = (stage: string) => moves.some((m) => m.stage === stage);
  if (has('requirement_received')) {
    return {
      stage: 'requirement_received',
      triggerLabel: 'Requirement received',
      title: 'Mark requirement received?',
      description: `${opp.number} will move from Qualified to Requirement Received.`,
      confirmLabel: 'Move to Requirement Received',
      successMessage: 'Moved to Requirement Received.',
      errorMessage: 'The opportunity stage could not be updated.',
    };
  }
  if (has('proposal_sent')) {
    return {
      stage: 'proposal_sent',
      triggerLabel: 'Proposal sent',
      title: 'Mark proposal sent?',
      description: `${opp.number} will move from Requirement Received to Proposal Sent.`,
      confirmLabel: 'Move to Proposal Sent',
      successMessage: 'Moved to Proposal Sent.',
      errorMessage: 'The opportunity stage could not be updated.',
    };
  }
  if (opp.stage === 'quotation_sent' && has('negotiation')) {
    return {
      stage: 'negotiation',
      triggerLabel: 'Move to negotiation',
      title: 'Move this opportunity to negotiation?',
      description: `${opp.number} will move from Quotation Sent to Negotiation.`,
      confirmLabel: 'Move to Negotiation',
      successMessage: 'Moved to Negotiation.',
      errorMessage: 'The opportunity stage could not be updated.',
    };
  }
  // A held deal resumes only to the stage it was held at (F1-Q53): the server sends that one move.
  const resume = resumeMove(opp.stage, moves);
  if (resume) {
    return {
      stage: resume.stage,
      triggerLabel: 'Resume',
      title: 'Resume this opportunity?',
      description: `${opp.number} will move from On Hold back to ${resume.label}.`,
      confirmLabel: 'Resume opportunity',
      successMessage: `Moved to ${resume.label}.`,
      errorMessage: 'The opportunity could not be resumed.',
    };
  }
  if (opp.stage === 'lost' && has('qualified')) {
    return {
      stage: 'qualified',
      triggerLabel: 'Reopen',
      title: 'Reopen this opportunity?',
      description: `${opp.number} will move from Lost back to Qualified.`,
      confirmLabel: 'Reopen opportunity',
      successMessage: 'Moved to Qualified.',
      errorMessage: 'The opportunity could not be reopened.',
    };
  }
  return null;
}

/** A quotation in one of these states was sent to the customer, so the deal reached Quotation Sent. */
const SENT_STATUSES: ReadonlySet<string> = new Set(['sent', 'accepted', 'rejected', 'expired']);

/**
 * The stages this deal has actually reached. The API records no stage history for deals, so only
 * what the record proves counts: Qualified (deals start there), the stage it stands at or was held
 * at, Quotation Sent once a quotation went out, and the stages the state machine says it passed
 * through (`stagesBefore`). A stage it may have skipped reads "Not recorded", never "Reached".
 */
function opportunityTimeline(
  opp: Pick<OpportunityDto, 'stage' | 'heldFromStage'>,
  quotations: readonly Pick<QuotationListItem, 'status'>[],
): TimelineStep[] {
  const heldAt = opp.stage === 'on_hold' ? (opp.heldFromStage ?? 'negotiation') : null;
  const reached = new Set<string>(['qualified']);
  const add = (stage: string) => {
    reached.add(stage);
    for (const before of stagesBefore('opportunity', stage)) reached.add(before);
  };
  add(opp.stage);
  if (heldAt) add(heldAt);
  if (opp.stage === 'won' || quotations.some((q) => SENT_STATUSES.has(q.status))) {
    add('quotation_sent');
  }
  // How far along the deal is known to be: earlier stages without proof were maybe skipped.
  const furthest = Math.max(...LINEAR_STAGES.map((stage, i) => (reached.has(stage) ? i : -1)));

  const steps = LINEAR_STAGES.map((stage, index): TimelineStep => {
    const title = <span>{stageLabel('opportunity', stage)}</span>;
    if (stage === opp.stage) {
      const won = stage === 'won';
      return { key: stage, title, status: won ? 'Won' : 'Current', tone: won ? 'done' : 'current' };
    }
    if (reached.has(stage)) return { key: stage, title, status: 'Reached', tone: 'done' };
    return index < furthest
      ? { key: stage, title, status: 'Not recorded', tone: 'muted' }
      : { key: stage, title, status: 'Not yet', tone: 'upcoming' };
  });
  if (opp.stage === 'on_hold') {
    steps.push({ key: 'on_hold', title: <span>On Hold</span>, status: 'Current', tone: 'warning' });
  } else if (opp.stage === 'lost') {
    steps.push({ key: 'lost', title: <span>Lost</span>, status: 'Current', tone: 'error' });
  }
  return steps;
}

function opportunityStageMessage(
  stage: OpportunityDto['stage'],
  canEdit: boolean,
  canReopen: boolean,
  resumeLabel: string | null,
): string {
  if (!canEdit) return 'You have read-only access to this opportunity.';
  if (stage === 'won') return 'This opportunity is won. Its stage is final.';
  if (stage === 'lost') {
    return canReopen
      ? 'This opportunity is lost. Use Reopen in the header to return it to Qualified.'
      : 'Only a manager can reopen a lost opportunity.';
  }
  if (stage === 'on_hold') {
    return resumeLabel
      ? `This opportunity is on hold. Use Resume in the header to return it to ${resumeLabel}.`
      : 'This opportunity is on hold.';
  }
  return 'Sending and accepting quotations update the stage automatically.';
}

function facts(o: OpportunityDto, customerName: string, numberSystems: NumberSystems): Fact[] {
  const dash = <span className={styles.quiet}>Not set</span>;
  return [
    {
      key: 'value',
      label: 'Estimated value',
      value: moneyOrNull(o.value, o.currency, numberSystems) ?? dash,
    },
    {
      key: 'probability',
      label: 'Probability',
      value: o.probability !== null ? `${o.probability}%` : dash,
    },
    {
      key: 'close',
      label: 'Expected closing date',
      value: o.expectedClose ? (
        <time dateTime={o.expectedClose}>{when(o.expectedClose, 'date')}</time>
      ) : (
        dash
      ),
    },
    {
      key: 'customer',
      label: 'Organization',
      value: <Link href={`/customers/${o.customerId}`}>{customerName}</Link>,
    },
    {
      key: 'lead',
      label: 'Source lead',
      value: o.leadId ? (
        <Link href={`/leads/${o.leadId}`}>Open the lead</Link>
      ) : (
        <span className={styles.quiet}>Created directly</span>
      ),
    },
    { key: 'created', label: 'Created', value: when(o.createdAt) },
  ];
}

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireStaffSession(`/opportunities/${id}`);
  const numberSystems = await getNumberSystems();

  const [oppResult, activityResult, plannedResult, quotationsResult, peopleResult] =
    await Promise.allSettled([
      getOpportunity(session, id),
      listActivities(session, { opportunityId: id, status: 'logged', limit: 100 }),
      // Planned follow-ups on the deal itself (migrated open tasks included).
      listActivities(session, { opportunityId: id, status: 'planned', limit: 100 }),
      listQuotations(session, { opportunityId: id }),
      // The owners list (the Reschedule choices) needs crm.lead.write, so it is only asked for with it;
      // names on the page come from the records themselves (D46).
      loadPeople(session, { owners: canAssignFollowUps(session) }),
    ]);

  if (oppResult.status === 'rejected') {
    const f = failureOf(oppResult.reason);
    if (f.status === 404) notFound();
    return (
      <Page>
        <Breadcrumb
          items={[{ label: 'Opportunities', href: '/opportunities' }, { label: 'Opportunity' }]}
        />
        <LoadProblem
          status={f.status}
          message={f.message}
          what="this opportunity"
          reloadHref={`/opportunities/${id}`}
        />
      </Page>
    );
  }
  const opp = oppResult.value;
  const customer = await getCustomer(session, opp.customerId).catch(() => null);
  const can = await getPermissionCheck(session);
  const canEdit = opp.canEdit ?? can('crm.opportunity.write');
  // Quotations follow their own grant (the API asks for quotation.draft plus read of the opportunity),
  // not write access to the opportunity.
  const canDraft = can('quotation.draft');
  const currentUserId = (await getMeOrNull(session.accessToken))?.id ?? null;
  const moves = resolvedMoves(
    'opportunity',
    opp.stage,
    opp.allowedMoves ?? (canEdit ? undefined : []),
    opp.heldFromStage,
  );
  const activityProblem =
    activityResult.status === 'rejected' ? failureOf(activityResult.reason) : null;
  const { owners } = peopleResult.status === 'fulfilled' ? peopleResult.value : { owners: [] };
  const plannedProblem =
    plannedResult.status === 'rejected' ? failureOf(plannedResult.reason).message : null;
  // Overdue is measured against the server's clock for this render.
  const now = new Date();
  const quotationProblem =
    quotationsResult.status === 'rejected' ? failureOf(quotationsResult.reason) : null;
  const quotations = quotationsResult.status === 'fulfilled' ? quotationsResult.value : [];
  const quotesHref = opportunityQuotationsHref(opp.id);
  const open = opp.stage !== 'lost' && opp.stage !== 'won';
  const primaryMove = primaryOpportunityMove(opp, moves);
  const canPutOnHold = moves.some((move) => move.stage === 'on_hold');
  // The options Mark lost offers (D54-3). Only asked for when the stage allows it. A 403 means this
  // person may read the opportunity but not change it, so the action is left out rather than shown and refused;
  // any other failure leaves the dialog able to add a reason.
  let canMarkLost = moves.some((move) => move.stage === 'lost');
  let lostReasons: LeadLostReason[] = [];
  if (canMarkLost) {
    try {
      lostReasons = await listOpportunityLostReasonChoices(session);
    } catch (err) {
      if (failureOf(err).status === 403) canMarkLost = false;
    }
  }
  const reasonLabel = opp.lostReason?.label ?? opp.stageReason;
  // A list that did not load falls back to New:
  // the New page checks again before it shows the builder.
  const entry: QuotationEntry = quotationEntryFor(quotations);
  const quoteCtaVariant = primaryMove ? 'secondary' : 'primary';

  return (
    <Page>
      <div className={styles.intro}>
        <Breadcrumb
          items={[{ label: 'Opportunities', href: '/opportunities' }, { label: opp.number }]}
        />
        <PageHeader
          title={opp.name}
          description={
            <span className={styles.metadata}>
              <StageBadge kind="opportunity" stage={opp.stage} />
              <span>{opp.number}</span>
            </span>
          }
          actions={
            <>
              {!canDraft ? (
                <LinkButton href={quotesHref} variant="secondary">
                  View quotations
                </LinkButton>
              ) : entry.kind === 'resume' ? (
                <>
                  <LinkButton href={quotesHref} variant="secondary">
                    View quotations
                  </LinkButton>
                  <LinkButton
                    href={editQuotationHref(entry.quotationId)}
                    variant={quoteCtaVariant}
                    aria-label={`Edit quotation ${entry.number}`}
                  >
                    Edit quotation
                  </LinkButton>
                </>
              ) : entry.kind === 'choose' ? (
                <>
                  {open ? (
                    <LinkButton
                      href={newQuotationHref(opp.id, { another: true })}
                      variant="secondary"
                    >
                      New quotation
                    </LinkButton>
                  ) : null}
                  <LinkButton href={quotesHref} variant={quoteCtaVariant}>
                    Choose a draft ({entry.count})
                  </LinkButton>
                </>
              ) : (
                <>
                  <LinkButton href={quotesHref} variant="secondary">
                    View quotations
                  </LinkButton>
                  {open ? (
                    <LinkButton href={newQuotationHref(opp.id)} variant={quoteCtaVariant}>
                      New quotation
                    </LinkButton>
                  ) : null}
                </>
              )}
              {primaryMove ? (
                <StageConfirmDialog
                  action={moveOpportunityStageAction}
                  id={opp.id}
                  version={opp.version}
                  stage={primaryMove.stage}
                  triggerLabel={primaryMove.triggerLabel}
                  triggerVariant="primary"
                  title={primaryMove.title}
                  description={primaryMove.description}
                  confirmLabel={primaryMove.confirmLabel}
                  successMessage={primaryMove.successMessage}
                  errorMessage={primaryMove.errorMessage}
                />
              ) : null}
              {canPutOnHold ? (
                <PutOnHoldDialog
                  noun="opportunity"
                  action={moveOpportunityStageAction}
                  id={opp.id}
                  number={opp.number}
                  version={opp.version}
                />
              ) : null}
              {canMarkLost ? (
                <MarkLostDialog
                  noun="opportunity"
                  action={moveOpportunityStageAction}
                  id={opp.id}
                  number={opp.number}
                  version={opp.version}
                  reasons={lostReasons}
                />
              ) : null}
            </>
          }
        />
      </div>

      <Card as="aside" aria-label="Stage" className={styles.stageCard}>
        <StatusTimeline
          label="Opportunity stages"
          steps={opportunityTimeline(opp, quotations)}
          className={styles.pipeline ?? ''}
        />
        <div className={styles.stageControls}>
          {reasonLabel || opp.stageNote ? (
            <div className={styles.reasonBox}>
              {reasonLabel ? <strong>{reasonLabel}</strong> : null}
              {opp.lostReason?.retired ? (
                <span className={styles.quiet}>
                  This reason is no longer offered for new opportunities.
                </span>
              ) : null}
              {opp.stageNote ? <span>{opp.stageNote}</span> : null}
            </div>
          ) : null}
          <p className={styles.quiet}>
            {opportunityStageMessage(
              opp.stage,
              canEdit,
              moves.some((move) => move.stage === 'qualified'),
              resumeMove(opp.stage, moves)?.label ?? null,
            )}
          </p>
        </div>
      </Card>

      <Panel title="Deal summary" className={styles.summary}>
        <FactList
          facts={facts(
            opp,
            customer ? `${customer.legalName} · ${customer.number}` : 'Customer name unavailable',
            numberSystems,
          )}
          className={styles.facts ?? ''}
        />
      </Panel>

      <Panel title="Quotations" className={styles.records}>
        {quotationProblem ? (
          <LoadProblem
            status={quotationProblem.status}
            message={quotationProblem.message}
            what="quotations"
            reloadHref={`/opportunities/${id}`}
          />
        ) : quotations.length ? (
          <Table
            caption="Opportunity quotations"
            minWidth={500}
            className={styles.quotesTable ?? ''}
          >
            <thead>
              <tr>
                <Th>Quotation</Th>
                <Th>Status</Th>
                <Th align="end">Total</Th>
                <Th>Valid until</Th>
              </tr>
            </thead>
            <tbody>
              {quotations.map((quote) => (
                <tr
                  key={quote.id}
                  data-accepted={
                    (quote.status === 'accepted' &&
                      quote.currentVersionId === opp.wonQuotationVersionId) ||
                    undefined
                  }
                >
                  <Td nowrap>
                    <Link href={`/quotations/${quote.id}`}>{quote.number}</Link>
                  </Td>
                  <Td nowrap>
                    <QuotationStatusBadge status={quote.status} />
                  </Td>
                  <Td align="end" nowrap>
                    {money(quote.total, quote.currency, numberSystems)}
                  </Td>
                  <Td nowrap>
                    <time dateTime={quote.validUntil}>{when(quote.validUntil, 'date')}</time>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className={styles.quiet}>No quotations for this opportunity yet.</p>
        )}
      </Panel>

      {plannedProblem !== null ? (
        // An empty card would claim nothing is planned; say the list did not load instead.
        <Panel title="Follow-ups" className={styles.records} as="aside">
          <Alert
            tone="error"
            role="alert"
            title="Follow-ups did not load"
            actions={<Link href={`/opportunities/${id}`}>Reload</Link>}
          >
            {plannedProblem}
          </Alert>
        </Panel>
      ) : (
        <FollowUpsCard
          items={plannedResult.status === 'fulfilled' ? plannedResult.value : []}
          owners={owners}
          schedule={false}
          canEdit={canEdit}
          currentUserId={currentUserId}
          now={now}
          className={styles.records}
        />
      )}

      <OpportunityActivities opportunityId={opp.id} canEdit={canEdit}>
        {activityProblem ? (
          <LoadProblem
            status={activityProblem.status}
            message={activityProblem.message}
            what="activities"
            reloadHref={`/opportunities/${id}`}
          />
        ) : (
          <ActivityList
            items={activityResult.status === 'fulfilled' ? activityResult.value : []}
            empty="Add a call, meeting, email or note for this opportunity."
          />
        )}
      </OpportunityActivities>
    </Page>
  );
}
