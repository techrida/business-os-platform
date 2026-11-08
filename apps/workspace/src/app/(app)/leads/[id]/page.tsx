import type { ActivityDto, LeadDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActivityForm } from '@/components/p2/crm/activity-form';
import { ConvertDialog } from '@/components/p2/crm/convert-dialog';
import { getLead, listActivities } from '@/components/p2/crm/crm-api';
import { moneyOrNull, sentence } from '@/components/p2/crm/format';
import { MoveForm } from '@/components/p2/crm/move-form';
import {
  ActivityList,
  LOGGABLE_KINDS,
  LoadProblem,
  StageBadge,
} from '@/components/p2/crm/server-bits';
import styles from '@/components/p2/crm/crm.module.css';
import { userMoves } from '@/components/p2/crm/stages';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { logActivityAction } from '../../activities/actions';
import { convertLeadAction, moveLeadStageAction } from '../actions';

export const metadata: Metadata = { title: 'Lead · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function facts(l: LeadDto): Fact[] {
  const dash = <span className={styles.quiet}>Not set</span>;
  return [
    {
      key: 'company',
      label: 'Company',
      value: <span className={styles.long}>{l.companyName}</span>,
    },
    {
      key: 'contact',
      label: 'Contact',
      value: <span className={styles.long}>{l.contactName}</span>,
    },
    {
      key: 'email',
      label: 'Email',
      value: l.email ? <span className={styles.long}>{l.email}</span> : dash,
    },
    { key: 'phone', label: 'Phone', value: l.phone ?? dash },
    {
      key: 'source',
      label: 'Source',
      value: l.campaign ? `${sentence(l.source)} · ${l.campaign}` : sentence(l.source),
    },
    {
      key: 'value',
      label: 'Expected value',
      value: moneyOrNull(l.expectedValue, l.currency) ?? dash,
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
    {
      key: 'followup',
      label: 'Next follow-up',
      value: l.nextFollowUpAt ? (
        when(l.nextFollowUpAt)
      ) : (
        <span className={styles.quiet}>None planned</span>
      ),
    },
    { key: 'created', label: 'Created', value: when(l.createdAt) },
    ...(l.requirement
      ? [
          {
            key: 'requirement',
            label: 'Requirement',
            value: <span className={styles.long}>{l.requirement}</span>,
            wide: true,
          },
        ]
      : []),
  ];
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireStaffSession(`/leads/${id}`);

  const [leadResult, activityResult] = await Promise.allSettled([
    getLead(session, id),
    listActivities(session, { leadId: id, limit: 100 }),
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
  let activities: ActivityDto[] | null = null;
  let activityProblem: string | null = null;
  if (activityResult.status === 'fulfilled') activities = activityResult.value;
  else activityProblem = failureOf(activityResult.reason).message;

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Leads', href: '/leads' }, { label: lead.number }]} />
      <PageHeader
        title={lead.title}
        status={<StageBadge kind="lead" stage={lead.stage} />}
        description={`${lead.number} · ${lead.companyName}`}
        actions={
          lead.stage === 'qualified' ? (
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
              }}
            />
          ) : lead.convertedOpportunityId ? (
            <LinkButton href={`/opportunities/${lead.convertedOpportunityId}`}>
              Open the opportunity
            </LinkButton>
          ) : null
        }
      />

      <div className={styles.columns}>
        <div className={styles.main}>
          <Panel title="Overview">
            <FactList facts={facts(lead)} />
          </Panel>

          <Panel
            title="Activity"
            description="Calls, meetings, emails, notes and tasks for this lead."
          >
            <ActivityForm
              action={logActivityAction}
              kinds={LOGGABLE_KINDS}
              subjectKind="leadId"
              subjectId={lead.id}
            />
            {activityProblem !== null ? (
              <Alert
                tone="error"
                role="alert"
                title="Activity did not load"
                actions={<Link href={`/leads/${id}`}>Reload</Link>}
              >
                {activityProblem}
              </Alert>
            ) : (
              <ActivityList
                items={activities ?? []}
                empty="Log the first call or note above and it appears here."
              />
            )}
          </Panel>
        </div>

        <div className={styles.side}>
          <Panel title="Stage" as="aside">
            <div>
              <StageBadge kind="lead" stage={lead.stage} />
            </div>
            {lead.stageReason ? (
              <div className={styles.reasonBox}>
                <strong>{lead.stageReason}</strong>
                {lead.stageNote ? <span>{lead.stageNote}</span> : null}
              </div>
            ) : null}
            <MoveForm
              action={moveLeadStageAction}
              recordId={lead.id}
              version={lead.version}
              moves={moves}
              emptyText={
                lead.stage === 'converted'
                  ? 'This lead is converted. Its stage is final.'
                  : 'No further moves from here. A manager can reopen a lost lead.'
              }
            />
            {lead.stage !== 'qualified' && lead.stage !== 'converted' ? (
              <p className={styles.quiet}>Only a Qualified lead can be converted.</p>
            ) : null}
          </Panel>
        </div>
      </div>
    </Page>
  );
}
