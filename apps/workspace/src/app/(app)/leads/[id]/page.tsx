import type { ActivityDto, LeadDto, LeadOwnerOption } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { NumberSystems } from '@bos/locale';

import { ActivityForm } from '@/components/p2/crm/activity-form';
import { ConvertDialog } from '@/components/p2/crm/convert-dialog';
import { getLead, listActivities } from '@/components/p2/crm/crm-api';
import { FollowUpsCard } from '@/components/p2/crm/follow-ups-card';
import { moneyOrNull, sentence } from '@/components/p2/crm/format';
import { MoveForm } from '@/components/p2/crm/move-form';
import { loadPeople } from '@/components/p2/crm/people';
import { ActivityList, LoadProblem, StageBadge } from '@/components/p2/crm/server-bits';
import { stageLabel, userMoves } from '@/components/p2/crm/stages';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { StatusTimeline, type TimelineStep } from '@/components/ui/status-timeline';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { when } from '@/lib/kernel-format';

import { logActivityAction } from '../../activities/actions';
import { convertLeadAction, moveLeadStageAction } from '../actions';
import styles from '../leads.module.css';
import { QualifyLead } from '../qualify-lead';

import { LeadOwnerField } from './lead-owner-field';
import { MarkLostDialog } from './mark-lost-dialog';

export const metadata: Metadata = { title: 'Lead · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function facts(l: LeadDto, owners: readonly LeadOwnerOption[], numberSystems: NumberSystems): Fact[] {
  const dash = <span className={styles.quiet}>Not set</span>;
  return [
    {
      key: 'company',
      label: 'Organization',
      value: l.customerId ? (
        <Link href={`/customers/${l.customerId}`}>{l.companyName}</Link>
      ) : (
        l.companyName
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
    { key: 'phone', label: 'Phone', value: l.phone ?? dash },
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

function leadTimeline(lead: LeadDto, activity: readonly ActivityDto[]): TimelineStep[] {
  const current = milestones.findIndex((stage) => stage === lead.stage);
  const steps = milestones.map((stage, index): TimelineStep => {
    const change = activity.find(
      (item) => item.kind === 'stage_change' && item.subject.endsWith(` to ${stage}`),
    );
    const date = stage === 'new' ? lead.createdAt : change?.occurredAt;
    const isCurrent = stage === lead.stage;
    const done = index < current || date !== undefined;
    return {
      key: stage,
      title: stageLabel('lead', stage),
      status: date ? when(date, 'date') : isCurrent ? 'Current' : done ? 'Reached' : 'Not yet',
      tone: isCurrent ? 'current' : done ? 'done' : 'upcoming',
    };
  });

  if (current === -1) {
    steps.push({
      key: lead.stage,
      title: stageLabel('lead', lead.stage),
      status: 'Current',
      tone: lead.stage === 'lost' ? 'error' : 'warning',
    });
  }
  return steps;
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireStaffSession(`/leads/${id}`);
  const numberSystems = await getNumberSystems();

  const [leadResult, plannedResult, loggedResult, peopleResult] = await Promise.allSettled([
    getLead(session, id),
    listActivities(session, { leadId: id, status: 'planned', limit: 100 }),
    listActivities(session, { leadId: id, status: 'logged', limit: 100 }),
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
  const moves = userMoves('lead', lead.stage);
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

  const canQualify = moves.some((move) => move.stage === 'qualified');
  const canMarkLost = moves.some((move) => move.stage === 'lost');

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
          // No wrapper at all for a lost or converted lead, so the header keeps no empty slot.
          canQualify || canMarkLost ? (
            <>
              {canQualify ? (
                <QualifyLead id={lead.id} number={lead.number} version={lead.version} />
              ) : null}
              {canMarkLost ? (
                <MarkLostDialog id={lead.id} number={lead.number} version={lead.version} />
              ) : null}
            </>
          ) : null
        }
      />

      <Card className={styles.timelineCard}>
        <StatusTimeline label="Lead progression" steps={leadTimeline(lead, logged ?? [])} />
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
              facts={facts(lead, owners, numberSystems)}
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
                empty="Calls, meetings and stage changes appear here."
              />
            )}
          </Panel>

          <Panel title="Log activity" className={styles.detailPanel}>
            <ActivityForm action={logActivityAction} subjectKind="leadId" subjectId={lead.id} />
          </Panel>
        </div>

        <div className={styles.detailStack}>
          <Panel
            id="lead-conversion"
            title={lead.convertedOpportunityId ? 'Opportunity' : 'Convert to opportunity'}
            className={styles.detailPanel}
            as="aside"
          >
            {lead.stage === 'qualified' ? (
              <>
                <p className={styles.quiet}>
                  Create an opportunity using this lead’s details. The lead will link to the new
                  opportunity.
                </p>
                <ConvertDialog
                  action={convertLeadAction}
                  lead={{
                    id: lead.id,
                    version: lead.version,
                    number: lead.number,
                    title: lead.title,
                    companyName: lead.companyName,
                    contactName: lead.contactName,
                    email: lead.email ?? '',
                    phone: lead.phone ?? '',
                    requirement: lead.requirement,
                    value: moneyOrNull(lead.expectedValue, lead.currency, numberSystems),
                    probability: lead.probability,
                    expectedClose: lead.expectedClose ? when(lead.expectedClose, 'date') : null,
                  }}
                />
              </>
            ) : lead.convertedOpportunityId ? (
              <LinkButton href={`/opportunities/${lead.convertedOpportunityId}`}>
                Open the opportunity <Icon name="chevron-right" size={16} />
              </LinkButton>
            ) : (
              <>
                <p className={styles.quiet}>Qualify this lead to unlock conversion.</p>
                <Button disabled>Convert to opportunity</Button>
              </>
            )}
          </Panel>

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
              owners={owners}
              now={now}
              className={styles.detailPanel}
            />
          )}

          <Panel title="Stage" className={styles.detailPanel} as="aside">
            <div>
              <StageBadge kind="lead" stage={lead.stage} />
            </div>
            {lead.stageReason ? (
              <Alert tone={lead.stage === 'lost' ? 'error' : 'warning'} title={lead.stageReason}>
                {lead.stageNote ? <span className={styles.longText}>{lead.stageNote}</span> : null}
              </Alert>
            ) : null}
            <MoveForm
              action={moveLeadStageAction}
              recordId={lead.id}
              version={lead.version}
              moves={moves}
              exclude={['qualified', 'lost', 'converted']}
              emptyText={
                lead.stage === 'converted'
                  ? 'This lead is converted. Its stage is final.'
                  : 'No further moves from here. A manager can reopen a lost lead.'
              }
            />
          </Panel>
        </div>
      </div>
    </Page>
  );
}
