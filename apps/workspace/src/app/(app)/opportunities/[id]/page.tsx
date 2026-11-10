import type { ActivityDto, OpportunityDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActivityForm } from '@/components/p2/crm/activity-form';
import { getOpportunity, listActivities } from '@/components/p2/crm/crm-api';
import { moneyOrNull } from '@/components/p2/crm/format';
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
import { moveOpportunityStageAction } from '../actions';

export const metadata: Metadata = { title: 'Opportunity · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function facts(o: OpportunityDto): Fact[] {
  const dash = <span className={styles.quiet}>Not set</span>;
  return [
    { key: 'value', label: 'Value', value: moneyOrNull(o.value, o.currency) ?? dash },
    {
      key: 'probability',
      label: 'Probability',
      value: o.probability !== null ? `${o.probability}%` : dash,
    },
    {
      key: 'close',
      label: 'Expected close',
      value: o.expectedClose ? when(o.expectedClose, 'date') : dash,
    },
    {
      key: 'customer',
      label: 'Customer record',
      value: <Link href={`/customers/${o.customerId}`}>View customer</Link>,
    },
    {
      key: 'lead',
      label: 'From lead',
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

  const [oppResult, activityResult] = await Promise.allSettled([
    getOpportunity(session, id),
    listActivities(session, { opportunityId: id, limit: 100 }),
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
  const moves = userMoves('opportunity', opp.stage);
  let activities: ActivityDto[] | null = null;
  let activityProblem: string | null = null;
  if (activityResult.status === 'fulfilled') activities = activityResult.value;
  else activityProblem = failureOf(activityResult.reason).message;

  const quotesHref = `/quotations?opportunityId=${encodeURIComponent(opp.id)}`;
  const newQuoteHref = `/quotations/new?opportunityId=${encodeURIComponent(opp.id)}`;

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Opportunities', href: '/opportunities' }, { label: opp.number }]}
      />
      <PageHeader
        title={opp.name}
        status={<StageBadge kind="opportunity" stage={opp.stage} />}
        description={opp.number}
        actions={
          <>
            <LinkButton href={quotesHref} variant="secondary">
              View quotations
            </LinkButton>
            {opp.stage !== 'lost' && opp.stage !== 'won' ? (
              <LinkButton href={newQuoteHref}>New quotation</LinkButton>
            ) : null}
          </>
        }
      />

      <div className={styles.columns}>
        <div className={styles.main}>
          <Panel title="Overview">
            <FactList facts={facts(opp)} />
          </Panel>

          <Panel
            title="Activity"
            description="Calls, meetings, emails, notes and tasks for this opportunity."
          >
            <ActivityForm
              action={logActivityAction}
              kinds={LOGGABLE_KINDS}
              subjectKind="opportunityId"
              subjectId={opp.id}
            />
            {activityProblem !== null ? (
              <Alert
                tone="error"
                role="alert"
                title="Activity did not load"
                actions={<Link href={`/opportunities/${id}`}>Reload</Link>}
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
              <StageBadge kind="opportunity" stage={opp.stage} />
            </div>
            {opp.stageReason ? (
              <div className={styles.reasonBox}>
                <strong>{opp.stageReason}</strong>
                {opp.stageNote ? <span>{opp.stageNote}</span> : null}
              </div>
            ) : null}
            <MoveForm
              action={moveOpportunityStageAction}
              recordId={opp.id}
              version={opp.version}
              moves={moves}
              emptyText={
                opp.stage === 'won'
                  ? 'Won. The system set this when a quotation was accepted.'
                  : 'No further moves from here. A manager can reopen a lost opportunity.'
              }
            />
            <p className={styles.quiet}>
              Quotation Sent and Won are set by the system as quotations are sent and accepted. You
              cannot set them by hand.
            </p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
