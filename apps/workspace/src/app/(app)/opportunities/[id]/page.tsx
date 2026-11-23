import type {
  CreditHoldDto,
  LeadLostReason,
  LeadOwnerOption,
  OpportunityDto,
  QuotationListItem,
} from '@bos/contracts';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { NumberSystems } from '@bos/locale';

import {
  getCreditHold,
  getOpportunity,
  listActivities,
  listOpportunityFollowUpAssignees,
  listOpportunityOwners,
} from '@/components/p2/crm/crm-api';
import { FollowUpList } from '@/components/p2/crm/follow-ups-card';
import { moneyOrNull } from '@/components/p2/crm/format';
import { MarkLostDialog } from '@/components/p2/crm/mark-lost-dialog';
import { PutOnHoldDialog } from '@/components/p2/crm/put-on-hold-dialog';
import { ActivityList, LoadProblem, StageBadge } from '@/components/p2/crm/server-bits';
import crmStyles from '@/components/p2/crm/crm.module.css';
import { StageConfirmDialog } from '@/components/p2/crm/stage-confirm-dialog';
import {
  resolvedMoves,
  resumeMove,
  stageLabel,
  stagesBefore,
  type Move,
} from '@/components/p2/crm/stages';
import { listQuotations } from '@/components/p2/quotations/api';
import { startQuotationBlocker } from '@/components/p2/quotations/opportunity-gate';
import {
  editQuotationHref,
  newQuotationHref,
  opportunityQuotationsHref,
  quotationEntryFor,
  type QuotationEntry,
} from '@/components/p2/quotations/resume';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
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
import { creditPositionView } from '@/components/p2/crm/credit-position';
import { CreditOverrideDialog } from './credit-override-dialog';
import { OpportunityOwnerField } from './opportunity-owner-field';
import styles from './detail.module.css';
import { OwnerCell } from '../../leads/lead-cells';
import { Tooltip } from '@/components/ui/tooltip';

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
  opp: Pick<OpportunityDto, 'stage' | 'number' | 'heldFromStage'>,
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
  // A hold older than that has no recorded stage, so the words name none.
  const resume = resumeMove(opp.stage, moves);
  if (resume) {
    const named = opp.heldFromStage ? resume.label : null;
    return {
      stage: resume.stage,
      triggerLabel: 'Resume',
      title: 'Resume this opportunity?',
      description: named
        ? `${opp.number} will move from On Hold back to ${named}.`
        : `${opp.number} will be taken off hold.`,
      confirmLabel: 'Resume opportunity',
      successMessage: named ? `Moved to ${named}.` : 'Opportunity resumed.',
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
 * The stages this deal has actually reached. Stage history starts with R4a Q13 and is listed on its
 * own, so the timeline counts only what the record proves: Qualified (deals start there), the stage
 * it stands at or was held at, Quotation Sent once a quotation went out (or the stage history shows
 * the deal there), and the stages the state
 * machine says it passed through (`stagesBefore`). A stage it may have skipped reads "Not recorded",
 * never "Reached". A hold older than F1-Q53 has no recorded stage, so it proves nothing past Qualified.
 */
function opportunityTimeline(
  opp: Pick<OpportunityDto, 'stage' | 'heldFromStage' | 'stageHistory'>,
  quotations: readonly Pick<QuotationListItem, 'status'>[],
): TimelineStep[] {
  const held = opp.stage === 'on_hold';
  const heldAt = held ? (opp.heldFromStage ?? null) : null;
  const reached = new Set<string>(['qualified']);
  const add = (stage: string) => {
    reached.add(stage);
    for (const before of stagesBefore('opportunity', stage)) reached.add(before);
  };
  // On Hold says nothing by itself about the stage before it; only a recorded held-from stage does.
  if (held) reached.add(opp.stage);
  else add(opp.stage);
  if (heldAt) add(heldAt);
  if (opp.stage === 'won' || quotations.some((q) => SENT_STATUSES.has(q.status))) {
    add('quotation_sent');
  }
  // A recorded move to or from a stage proves the deal stood there, even once its quotation is
  // cancelled (losing a deal cancels its open quotations, sent ones included).
  for (const move of opp.stageHistory ?? []) {
    for (const stage of [move.from, move.to]) {
      if (LINEAR_STAGES.some((linear) => linear === stage)) add(stage);
    }
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
    // The unknown stage of an old hold could be any open one, so none of them reads "Not yet".
    return index < furthest || (held && heldAt === null && stage !== 'won')
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

/**
 * `resume` is null when the caller cannot resume the deal; its `label` is null when the hold has no recorded
 * stage (a hold older than F1-Q53), and then no stage is named.
 */
function opportunityStageMessage(
  stage: OpportunityDto['stage'],
  canEdit: boolean,
  canReopen: boolean,
  resume: { label: string | null } | null,
): string {
  if (!canEdit) return 'You have read-only access to this opportunity.';
  if (stage === 'won') return 'This opportunity is won. Its stage is final.';
  if (stage === 'lost') {
    return canReopen
      ? 'This opportunity is lost. Use Reopen in the header to return it to Qualified.'
      : 'This opportunity is lost. Reopening needs reopen access.';
  }
  if (stage === 'on_hold') {
    if (resume === null) return 'This opportunity is on hold.';
    return resume.label
      ? `This opportunity is on hold. Use Resume in the header to return it to ${resume.label}.`
      : 'This opportunity is on hold. Use Resume in the header to take it off hold.';
  }
  return 'Sending and accepting quotations update the stage automatically.';
}

/** `a, b and c`, with a capital first letter: the parts of the credit position as one sentence. */
function sentenceOf(parts: string[]): string {
  const text =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  return text.replace(/^./, (c) => c.toUpperCase());
}

/**
 * Why a deal is on credit hold (F1-Q20), for everyone who can read it. Holders of `credit.override`
 * also get the amounts (when they load) and the Override action; anyone else is told who can
 * override, with no button that would only be refused.
 */
function CreditHoldBanner({
  opp,
  canOverride,
  hold,
  numberSystems,
}: {
  opp: OpportunityDto;
  canOverride: boolean;
  hold: CreditHoldDto | null;
  numberSystems: NumberSystems;
}) {
  // The hold counts the customer's confirmed orders that no invoice covers yet and the deal's accepted quotation
  // on top of what it owes (Kuu R4a Q1b, R5 FU4), so the amounts name every part: open receivables alone may be
  // under the limit.
  const amount = (value: string) => money(value, hold?.currency ?? 'NPR', numberSystems);
  const parts =
    hold && hold.creditLimit !== null
      ? [
          `open receivables are ${amount(hold.exposure)}`,
          ...(Number(hold.uninvoiced) > 0
            ? [`confirmed orders not yet invoiced are ${amount(hold.uninvoiced)}`]
            : []),
          ...(Number(hold.orderValue) > 0
            ? [`this deal's order is ${amount(hold.orderValue)}`]
            : []),
        ]
      : [];
  const amounts =
    hold && hold.creditLimit !== null
      ? ` ${sentenceOf(parts)}: ${amount(hold.exposureWithOrder)} against a limit of ${amount(hold.creditLimit)}.`
      : '';
  return (
    <Alert
      tone="warning"
      role="status"
      title="Credit hold"
      actions={
        canOverride ? (
          <CreditOverrideDialog
            opportunityId={opp.id}
            number={opp.number}
            quotationVersionId={hold?.pendingQuotationVersionId ?? null}
            position={hold ? creditPositionView(hold, numberSystems) : undefined}
          />
        ) : undefined
      }
    >
      {`${hold !== null && Number(hold.orderValue) === 0 ? 'This' : "With this deal's order, this"} customer is over its credit limit, so an accepted quotation on this deal cannot become a sales order until the hold is overridden or lifted.${amounts} `}
      {canOverride
        ? 'Override the hold to let it go ahead, or wait for a payment to bring the customer under the limit.'
        : 'Someone with credit override access can override the hold. A payment that brings the customer under the limit also lifts it.'}
    </Alert>
  );
}

/**
 * Every recorded stage change, oldest first (R4a Q13): when, who, and from which stage to which. A move no person
 * made reads System. Recording started with this list, so an older deal may have none yet.
 */
function StageHistory({ entries }: { entries: NonNullable<OpportunityDto['stageHistory']> }) {
  if (entries.length === 0) {
    return <p className={styles.quiet}>No stage changes recorded yet.</p>;
  }
  return (
    <ol className={crmStyles.timeline} aria-label="Stage changes">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className={crmStyles.entry}>
          <div className={crmStyles.entryHead}>
            <span className={crmStyles.entryTitle}>
              {`${stageLabel('opportunity', entry.from)} to ${stageLabel('opportunity', entry.to)}`}
            </span>
          </div>
          <p className={crmStyles.entryWhen}>
            <time dateTime={entry.at}>{when(entry.at)}</time>
            {` · ${entry.actorName ?? 'System'}`}
          </p>
        </li>
      ))}
    </ol>
  );
}

function facts(
  o: OpportunityDto,
  customerName: string,
  numberSystems: NumberSystems,
  owner: ReactNode,
): Fact[] {
  const dash = <span className={styles.quiet}>Not set</span>;
  return [
    { key: 'owner', label: 'Owner', value: owner },
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

  const [oppResult, activityResult, plannedResult, quotationsResult] = await Promise.allSettled([
    getOpportunity(session, id),
    listActivities(session, { opportunityId: id, status: 'logged', limit: 100 }),
    // Planned follow-ups on the deal itself (migrated open tasks included).
    listActivities(session, { opportunityId: id, status: 'planned', limit: 100 }),
    listQuotations(session, { opportunityId: id }),
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
  // Quotations follow the server's own answer for this deal (FX-Q1, FX-Q2): quotation.draft plus reach
  // as owner, department or lead creator. An assigned follow-up alone does not count; omitted means no.
  const canDraft = opp.canDraftQuotation === true;
  // Said in place of New quotation on an open deal the server refuses (R4a Q4 a).
  const draftBlocker = startQuotationBlocker(opp);
  const currentUserId = (await getMeOrNull(session.accessToken))?.id ?? null;
  const moves = resolvedMoves(
    'opportunity',
    opp.stage,
    opp.allowedMoves ?? (canEdit ? undefined : []),
    opp.heldFromStage,
  );
  const activityProblem =
    activityResult.status === 'rejected' ? failureOf(activityResult.reason) : null;
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
  // The people an editor may hand the deal to (F1-Q51), and the wider list its follow-ups may go to
  // (a reader is enough for a follow-up, not for an owner). Anyone else, or a failed list, sees the
  // owner's name alone; a follow-up then goes to whoever schedules it.
  let ownerChoices: LeadOwnerOption[] = [];
  let assigneeChoices: LeadOwnerOption[] = [];
  if (canEdit) {
    [ownerChoices, assigneeChoices] = await Promise.all([
      listOpportunityOwners(session).catch(() => []),
      listOpportunityFollowUpAssignees(session).catch(() => []),
    ]);
  }
  const ownerFact =
    open && ownerChoices.length > 1 ? (
      <OpportunityOwnerField
        opportunityId={opp.id}
        version={opp.version}
        ownerUserId={opp.ownerUserId}
        ownerName={opp.ownerName ?? null}
        owners={ownerChoices}
      />
    ) : (
      <OwnerCell name={opp.ownerName ?? null} seedId={opp.ownerUserId} />
    );
  // F1-Q20: the deal's flag is booleans only; the amounts are for credit.override holders. The hold
  // matters only while a sales order can still come: on an open deal, or a won one whose order has not
  // gone ahead. A lost deal, or a won one with its order, shows no hold and offers no override.
  const creditHeld =
    opp.creditHold?.held === true &&
    opp.creditHold.overridden !== true &&
    (open || (opp.stage === 'won' && opp.creditHold.ordered !== true));
  const canOverride = creditHeld && can('credit.override');
  const creditHold = canOverride ? await getCreditHold(session, opp.id).catch(() => null) : null;
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
              {creditHeld ? (
                <Tooltip content="With this deal's order the customer is over its credit limit: no sales order until the hold is overridden or lifted.">
                  <Badge tone="warning" className={styles.holdBadge}>
                    <Icon name="credit-card" size={12} />
                    Credit hold
                  </Badge>
                </Tooltip>
              ) : null}
              <span>{opp.number}</span>
            </span>
          }
          actions={
            <>
              {!canDraft ? (
                <>
                  <Tooltip content={draftBlocker}>
                    <LinkButton href={quotesHref} variant="secondary">
                      View quotations
                    </LinkButton>
                  </Tooltip>
                </>
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
        {creditHeld ? (
          <CreditHoldBanner
            opp={opp}
            canOverride={canOverride}
            hold={creditHold}
            numberSystems={numberSystems}
          />
        ) : null}
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
              resumeMove(opp.stage, moves)
                ? { label: opp.heldFromStage ? stageLabel('opportunity', opp.heldFromStage) : null }
                : null,
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
            ownerFact,
          )}
          className={styles.facts ?? ''}
        />
      </Panel>

      <Panel title="Stage history" className={styles.summary}>
        <StageHistory entries={opp.stageHistory ?? []} />
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

      <OpportunityActivities
        opportunityId={opp.id}
        canEdit={canEdit}
        ownerUserId={opp.ownerUserId}
        owners={assigneeChoices}
        planned={
          plannedProblem !== null ? (
            // An empty list would claim nothing is planned; say the list did not load instead.
            <Alert
              tone="error"
              role="alert"
              title="Follow-ups did not load"
              actions={<Link href={`/opportunities/${id}`}>Reload</Link>}
            >
              {plannedProblem}
            </Alert>
          ) : (
            <FollowUpList
              items={plannedResult.status === 'fulfilled' ? plannedResult.value : []}
              owners={assigneeChoices}
              canEdit={canEdit}
              currentUserId={currentUserId}
              now={now}
              empty={<p className={styles.quiet}>Nothing planned.</p>}
            />
          )
        }
      >
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
            record="opportunity"
            empty={
              canEdit
                ? 'Use Log activity to record a call, meeting, email or note.'
                : 'Calls, meetings, emails and notes logged on this opportunity show here.'
            }
          />
        )}
      </OpportunityActivities>
    </Page>
  );
}
