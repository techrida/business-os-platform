import { countryName, type ActivityDto, type LeadDto, type LeadOwnerOption } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { NumberSystems } from '@bos/locale';

import { ActivityForm } from '@/components/p2/crm/activity-form';
import { ConvertDialog } from '@/components/p2/crm/convert-dialog';
import { getLead, listActivities } from '@/components/p2/crm/crm-api';
import { FollowUpsCard } from '@/components/p2/crm/follow-ups-card';
import { moneyOrNull, sentence } from '@/components/p2/crm/format';
import { MarkContactedDialog } from '@/components/p2/crm/mark-contacted-dialog';
import { MarkLostDialog } from '@/components/p2/crm/mark-lost-dialog';
import { loadPeople } from '@/components/p2/crm/people';
import { PutOnHoldDialog } from '@/components/p2/crm/put-on-hold-dialog';
import { ActivityList, LoadProblem, StageBadge } from '@/components/p2/crm/server-bits';
import { StageConfirmDialog } from '@/components/p2/crm/stage-confirm-dialog';
import { resolvedMoves, resumeMove, stageLabel, stagesBefore } from '@/components/p2/crm/stages';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { StatusTimeline, type TimelineStep } from '@/components/ui/status-timeline';
import { listLeadLostReasonChoices } from '@/lib/api-lead-lost-reasons';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { when } from '@/lib/kernel-format';
import { getMeOrNull, getPermissionCheck } from '@/lib/live-permissions';

import { logActivityAction } from '../../activities/actions';
import { convertLeadAction, moveLeadStageAction, unlinkLeadCustomerAction } from '../actions';
import styles from '../leads.module.css';
import { QualifyLead } from '../qualify-lead';

import { LeadAddressField } from './lead-address-field';
import { LeadContactField } from './lead-contact-field';
import { LeadCustomerField } from './lead-customer-field';
import { LeadOwnerField } from './lead-owner-field';

export const metadata: Metadata = { title: 'Lead · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function facts(
  l: LeadDto,
  owners: readonly LeadOwnerOption[],
  numberSystems: NumberSystems,
  /** Whether the caller may change the country and phones (an editor, the lead not converted). */
  editable: boolean,
): Fact[] {
  const dash = <span className={styles.quiet}>Not set</span>;
  return [
    {
      key: 'company',
      label: 'Organization',
      value: (
        <LeadCustomerField
          leadId={l.id}
          version={l.version}
          customerId={l.customerId}
          companyName={l.companyName}
          editable={editable}
        />
      ),
    },
    {
      key: 'contact',
      label: 'Contact person',
      value: l.contactName,
    },
    {
      key: 'email',
      label: 'Email',
      value: l.email ?? dash,
    },
    {
      key: 'phone',
      label: 'Phone',
      value: (
        <LeadContactField
          leadId={l.id}
          version={l.version}
          country={l.country}
          phones={l.phones}
          editable={editable}
        />
      ),
      // The editor (Country, the phone list and Save) needs a full row; a number fits a cell.
      wide: editable,
    },
    { key: 'country', label: 'Country', value: countryName(l.country) },
    {
      key: 'address',
      label: 'Address',
      value: (
        <LeadAddressField
          leadId={l.id}
          version={l.version}
          address={l.address}
          editable={editable}
        />
      ),
      wide: editable,
    },
    {
      key: 'source',
      label: 'Lead source',
      value: l.campaign ? `${sentence(l.source)} · ${l.campaign}` : sentence(l.source),
    },
    {
      key: 'value',
      label: 'Expected value',
      value: moneyOrNull(l.expectedValue, l.currency, numberSystems) ?? dash,
    },
    {
      key: 'probability',
      label: 'Probability',
      value: l.probability !== null ? `${l.probability}%` : dash,
    },
    {
      key: 'close',
      label: 'Expected close',
      value: l.expectedClose ? when(l.expectedClose, 'date') : dash,
    },
    { key: 'created', label: 'Created', value: when(l.createdAt) },
    {
      key: 'owner',
      label: 'Lead owner',
      value: (
        <LeadOwnerField
          leadId={l.id}
          version={l.version}
          ownerUserId={l.ownerUserId}
          ownerName={l.ownerName}
          owners={owners}
        />
      ),
      // The editor (a Select and Save) needs a full row; a read-only owner fits a cell.
      wide: owners.length > 1,
    },
    ...(l.requirement
      ? [
          {
            key: 'requirement',
            label: 'Requirement',
            value: <span className={styles.longText}>{l.requirement}</span>,
            wide: true,
          },
        ]
      : []),
  ];
}

const milestones = ['new', 'contacted', 'qualified', 'converted'] as const;

function latestStageChange(
  activity: readonly ActivityDto[],
  stage: LeadDto['stage'],
): ActivityDto | undefined {
  let latest: ActivityDto | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const item of activity) {
    if (item.kind !== 'stage_change' || !item.subject.endsWith(` to ${stage}`)) continue;
    const at = Date.parse(item.occurredAt);
    const score = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (latest === undefined || score >= latestTime) {
      latest = item;
      latestTime = score;
    }
  }
  return latest;
}

/**
 * The stages this lead has actually reached (D48, F1-Q53): New (it was created there), the stage it
 * stands at or was held at, every stage it recorded a move into, and the stages the state machine
 * says it passed through on the way (`stagesBefore`). Nothing is marked by position alone.
 */
function reachedLeadStages(lead: LeadDto, history: readonly ActivityDto[] | null): Set<string> {
  const reached = new Set<string>(['new']);
  const add = (stage: string) => {
    reached.add(stage);
    for (const before of stagesBefore('lead', stage)) reached.add(before);
  };
  add(lead.stage);
  if (lead.stage === 'on_hold' && lead.heldFromStage) add(lead.heldFromStage);
  for (const stage of milestones) {
    if (history && latestStageChange(history, stage)) add(stage);
  }
  return reached;
}

function leadTimeline(lead: LeadDto, history: readonly ActivityDto[] | null): TimelineStep[] {
  const reached = reachedLeadStages(lead, history);
  const steps = milestones.map((stage): TimelineStep => {
    const change = history ? latestStageChange(history, stage) : undefined;
    const date = stage === 'new' ? lead.createdAt : change?.occurredAt;
    const isCurrent = stage === lead.stage;
    const done = reached.has(stage);
    return {
      key: stage,
      title: stageLabel('lead', stage),
      status: date ? when(date, 'date') : isCurrent ? 'Current' : done ? 'Reached' : 'Not yet',
      tone: isCurrent ? 'current' : done ? 'done' : 'upcoming',
    };
  });

  if (lead.stage === 'on_hold' || lead.stage === 'lost') {
    const change = history ? latestStageChange(history, lead.stage) : undefined;
    steps.push({
      key: lead.stage,
      title: stageLabel('lead', lead.stage),
      status: change?.occurredAt ? when(change.occurredAt, 'date') : 'Current',
      tone: lead.stage === 'lost' ? 'error' : 'warning',
    });
  }
  return steps;
}

const CONTACT_KINDS: ReadonlySet<string> = new Set(['call', 'email', 'meeting']);

/**
 * Whether the loaded logged activities already hold a done call, email or meeting, the contact the
 * server needs before any move to Contacted (FR-6, D48). A list that did not load counts as no.
 */
function hasLoggedContact(logged: readonly ActivityDto[] | null): boolean {
  const now = Date.now();
  // The server's own test: completed, or never scheduled and already occurred (a future-dated one does not count).
  return (logged ?? []).some(
    (item) =>
      CONTACT_KINDS.has(item.kind) &&
      item.cancelledAt === null &&
      (item.completedAt !== null || (item.dueAt === null && Date.parse(item.occurredAt) <= now)),
  );
}

function leadStageMessage(
  stage: LeadDto['stage'],
  canEdit: boolean,
  canReopen: boolean,
  resumeLabel: string | null,
): string {
  if (!canEdit) return 'You have read-only access to this lead.';
  if (stage === 'new') {
    return 'Log a call, email or meeting with Mark contacted to move this lead to Contacted.';
  }
  if (stage === 'contacted') {
    return 'Use the header actions to qualify this lead, put it on hold, or mark it lost.';
  }
  if (stage === 'qualified') {
    return 'Qualifying is complete. Convert this lead to an opportunity, put it on hold, or mark it lost.';
  }
  if (stage === 'on_hold') {
    return resumeLabel
      ? `This lead is on hold. Use Resume in the header to move it back to ${resumeLabel}.`
      : 'This lead is on hold.';
  }
  if (stage === 'lost') {
    return canReopen
      ? 'This lead is lost. Use Reopen in the header to return it to Contacted.'
      : 'This lead is lost. Reopening needs reopen access.';
  }
  return 'This lead is converted. Its stage is final.';
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireStaffSession(`/leads/${id}`);
  const numberSystems = await getNumberSystems();

  const [leadResult, plannedResult, loggedResult, historyResult, peopleResult] =
    await Promise.allSettled([
      getLead(session, id),
      listActivities(session, { leadId: id, status: 'planned', limit: 100 }),
      listActivities(session, { leadId: id, status: 'logged', limit: 100 }),
      // The stage history on its own, so a busy lead's 100 newest activities cannot crowd it out.
      listActivities(session, { leadId: id, kind: 'stage_change', limit: 100 }),
      loadPeople(session),
    ]);

  if (leadResult.status === 'rejected') {
    const f = failureOf(leadResult.reason);
    if (f.status === 404) notFound();
    return (
      <Page>
        <Breadcrumb items={[{ label: 'Leads', href: '/leads' }, { label: 'Lead' }]} />
        <LoadProblem
          status={f.status}
          message={f.message}
          what="this lead"
          reloadHref={`/leads/${id}`}
        />
      </Page>
    );
  }
  const lead = leadResult.value;
  const canEdit = lead.canEdit ?? (await getPermissionCheck(session))('crm.lead.write');
  const meRead = await getMeOrNull(session.accessToken);
  const currentUserId = meRead?.id ?? null;
  const me =
    meRead?.id && meRead.displayName ? { userId: meRead.id, name: meRead.displayName } : null;
  const moves = resolvedMoves(
    'lead',
    lead.stage,
    lead.allowedMoves ?? (canEdit ? undefined : []),
    lead.heldFromStage,
  );
  const planned = plannedResult.status === 'fulfilled' ? plannedResult.value : null;
  const plannedProblem =
    plannedResult.status === 'rejected' ? failureOf(plannedResult.reason).message : null;
  const logged = loggedResult.status === 'fulfilled' ? loggedResult.value : null;
  const loggedProblem =
    loggedResult.status === 'rejected' ? failureOf(loggedResult.reason).message : null;
  // Owners feed the owner editor and the follow-up choices; every name shown comes from its own record (D46).
  // Without them the page still works, read-only.
  const { owners } = peopleResult.status === 'fulfilled' ? peopleResult.value : { owners: [] };
  // Overdue is measured against the server's clock for this render.
  const now = new Date();

  const hasMove = (stage: string) => moves.some((move) => move.stage === stage);
  const canMarkContacted = lead.stage === 'new' && hasMove('contacted');
  const canQualify = lead.stage === 'contacted' && hasMove('qualified');
  // A held lead resumes only to the stage it was held at (F1-Q53): the server sends that one move.
  const resume = resumeMove(lead.stage, moves);
  const canResume = resume !== null;
  const canReopen = lead.stage === 'lost' && hasMove('contacted');
  // Resume and Reopen to Contacted log the contact in the same step unless one is already done (FR-6, D48).
  const needsContact = !hasLoggedContact(logged);
  // Convert is its own action, not a stage move: the qualified lead's editors get it in the header.
  const canConvert = lead.stage === 'qualified' && canEdit;
  const canPutOnHold = hasMove('on_hold');
  const canMarkLost = hasMove('lost');
  const hasHeaderActions =
    canMarkContacted ||
    canQualify ||
    canConvert ||
    canResume ||
    canReopen ||
    canPutOnHold ||
    canMarkLost;
  // The options Mark lost offers (D49). Only asked for when the action is shown; a failure leaves the dialog able to add one.
  const lostReasons = canMarkLost ? await listLeadLostReasonChoices(session).catch(() => []) : [];
  const reasonLabel = lead.lostReason?.label ?? lead.stageReason;
  const hasReasonDetail = Boolean(reasonLabel || lead.stageNote);

  return (
    <Page className={styles.detail}>
      <Breadcrumb items={[{ label: 'Leads', href: '/leads' }, { label: lead.number }]} />
      <PageHeader
        title={lead.title}
        description={
          <span className={styles.detailMeta}>
            <StageBadge kind="lead" stage={lead.stage} />
            <span className={styles.recordNumber}>{lead.number}</span>
            <span>{lead.companyName}</span>
          </span>
        }
        actions={
          // No wrapper at all when no moves are allowed, so the header keeps no empty slot.
          hasHeaderActions ? (
            <>
              {canMarkContacted ? (
                <MarkContactedDialog
                  action={moveLeadStageAction}
                  id={lead.id}
                  number={lead.number}
                  version={lead.version}
                />
              ) : null}
              {canQualify ? (
                <QualifyLead
                  id={lead.id}
                  number={lead.number}
                  version={lead.version}
                  variant="primary"
                />
              ) : null}
              {canConvert ? (
                <ConvertDialog
                  action={convertLeadAction}
                  unlinkAction={unlinkLeadCustomerAction}
                  lead={{
                    id: lead.id,
                    version: lead.version,
                    number: lead.number,
                    title: lead.title,
                    companyName: lead.companyName,
                    customerId: lead.customerId,
                    contactId: lead.contactId,
                    contactName: lead.contactName,
                    email: lead.email ?? '',
                    country: lead.country,
                    address: lead.address,
                    phones: lead.phones,
                    requirement: lead.requirement,
                    value: moneyOrNull(lead.expectedValue, lead.currency, numberSystems),
                    probability: lead.probability,
                    expectedClose: lead.expectedClose ? when(lead.expectedClose, 'date') : null,
                  }}
                />
              ) : null}
              {resume && resume.stage === 'contacted' && needsContact ? (
                <MarkContactedDialog
                  action={moveLeadStageAction}
                  id={lead.id}
                  number={lead.number}
                  version={lead.version}
                  triggerLabel="Resume"
                  fromLabel="On Hold"
                  title="Resume this lead?"
                  confirmLabel="Resume lead"
                />
              ) : resume ? (
                <StageConfirmDialog
                  action={moveLeadStageAction}
                  id={lead.id}
                  version={lead.version}
                  stage={resume.stage}
                  triggerLabel="Resume"
                  triggerVariant="primary"
                  title="Resume this lead?"
                  description={`${lead.number} will move from On Hold back to ${resume.label}.`}
                  confirmLabel="Resume lead"
                  successMessage={`Moved to ${resume.label}.`}
                  errorMessage="The lead could not be resumed."
                />
              ) : null}
              {canReopen && needsContact ? (
                <MarkContactedDialog
                  action={moveLeadStageAction}
                  id={lead.id}
                  number={lead.number}
                  version={lead.version}
                  triggerLabel="Reopen"
                  fromLabel="Lost"
                  title="Reopen this lead?"
                  confirmLabel="Reopen lead"
                />
              ) : canReopen ? (
                <StageConfirmDialog
                  action={moveLeadStageAction}
                  id={lead.id}
                  version={lead.version}
                  stage="contacted"
                  triggerLabel="Reopen"
                  triggerVariant="primary"
                  title="Reopen this lead?"
                  description={`${lead.number} will move from Lost back to Contacted.`}
                  confirmLabel="Reopen lead"
                  successMessage="Moved to Contacted."
                  errorMessage="The lead could not be reopened."
                />
              ) : null}
              {canPutOnHold ? (
                <PutOnHoldDialog
                  noun="lead"
                  action={moveLeadStageAction}
                  id={lead.id}
                  number={lead.number}
                  version={lead.version}
                />
              ) : null}
              {canMarkLost ? (
                <MarkLostDialog
                  noun="lead"
                  action={moveLeadStageAction}
                  id={lead.id}
                  number={lead.number}
                  version={lead.version}
                  reasons={lostReasons}
                />
              ) : null}
            </>
          ) : null
        }
      />

      <Card className={styles.timelineCard}>
        <StatusTimeline
          label="Lead progression"
          steps={leadTimeline(
            lead,
            historyResult.status === 'fulfilled' ? historyResult.value : null,
          )}
        />
        {hasReasonDetail ? (
          <div className={styles.timelineReason}>
            <Alert
              tone={lead.stage === 'lost' ? 'error' : 'warning'}
              title={reasonLabel ?? stageLabel('lead', lead.stage)}
            >
              {lead.lostReason?.retired ? (
                <span className={styles.longText}>
                  This reason is no longer offered for new leads.
                </span>
              ) : null}
              {lead.stageNote ? <span className={styles.longText}>{lead.stageNote}</span> : null}
            </Alert>
          </div>
        ) : null}
      </Card>

      <div className={styles.detailColumns}>
        <div className={styles.detailStack}>
          <Panel
            title={
              <>
                {/* Figma's card eyebrow, as on the create form. Decoration only. */}
                <span className={styles.eyebrow} aria-hidden="true">
                  01 · The basics
                </span>
                Lead overview
              </>
            }
            className={styles.detailPanel}
          >
            <FactList
              facts={facts(
                lead,
                canEdit && lead.stage !== 'converted' ? owners : [],
                numberSystems,
                canEdit && lead.stage !== 'converted',
              )}
              className={styles.overviewFacts ?? ''}
            />
          </Panel>

          <Panel title="History" className={styles.detailPanel}>
            {loggedProblem !== null ? (
              <Alert
                tone="error"
                role="alert"
                title="Activity did not load"
                actions={<Link href={`/leads/${id}`}>Reload</Link>}
              >
                {loggedProblem}
              </Alert>
            ) : (
              <ActivityList
                items={logged ?? []}
                record="lead"
                empty={
                  canEdit
                    ? 'Use Log activity to record a call, meeting, email or note.'
                    : 'Calls, meetings, emails and notes logged on this lead show here.'
                }
              />
            )}
          </Panel>

          <Panel title="Log activity" className={styles.detailPanel}>
            {canEdit ? (
              <ActivityForm action={logActivityAction} subjectKind="leadId" subjectId={lead.id} />
            ) : (
              <p className={styles.quiet}>You have read-only access to this lead.</p>
            )}
          </Panel>
        </div>

        <div className={styles.detailStack}>
          {lead.convertedOpportunityId ? (
            <Panel
              id="lead-conversion"
              title="Opportunity"
              className={styles.detailPanel}
              as="aside"
            >
              <LinkButton href={`/opportunities/${lead.convertedOpportunityId}`}>
                Open the opportunity <Icon name="chevron-right" size={16} />
              </LinkButton>
            </Panel>
          ) : null}

          {plannedProblem !== null ? (
            // An empty card would claim nothing is planned; say the list did not load instead.
            <Panel title="Follow-ups" className={styles.detailPanel} as="aside">
              <Alert
                tone="error"
                role="alert"
                title="Follow-ups did not load"
                actions={<Link href={`/leads/${id}`}>Reload</Link>}
              >
                {plannedProblem}
              </Alert>
            </Panel>
          ) : (
            <FollowUpsCard
              leadId={lead.id}
              items={planned ?? []}
              ownerUserId={lead.ownerUserId}
              ownerName={lead.ownerName}
              me={me}
              owners={owners}
              schedule={canEdit}
              canEdit={canEdit}
              currentUserId={currentUserId}
              now={now}
              className={styles.detailPanel}
            />
          )}

          <Panel title="Stage" className={styles.detailPanel} as="aside">
            <div>
              <StageBadge kind="lead" stage={lead.stage} />
            </div>
            <p className={styles.quiet}>
              {leadStageMessage(lead.stage, canEdit, canReopen, resume?.label ?? null)}
            </p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
