import { OPPORTUNITY_STAGES, type OpportunityDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { NumberSystem } from '@bos/locale';

import { getOpportunity, listActivities, listLeadOwners } from '@/components/p2/crm/crm-api';
import { moneyOrNull } from '@/components/p2/crm/format';
import { MoveForm } from '@/components/p2/crm/move-form';
import { ActivityList, LoadProblem, peopleById, StageBadge } from '@/components/p2/crm/server-bits';
import { stageLabel, userMoves } from '@/components/p2/crm/stages';
import { listQuotations } from '@/components/p2/quotations/api';
import {
  editQuotationHref,
  newQuotationHref,
  opportunityQuotationsHref,
  quotationEntryFor,
  type QuotationEntry,
} from '@/components/p2/quotations/resume';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { StatusTimeline } from '@/components/ui/status-timeline';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { getCustomer } from '@/components/p2/customers/api';

import { moveOpportunityStageAction } from '../actions';
import { OpportunityActivities } from './activity-panel';
import styles from './detail.module.css';

export const metadata: Metadata = { title: 'Opportunity · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function facts(o: OpportunityDto, customerName: string, numberSystem: NumberSystem): Fact[] {
  const dash = <span className={styles.quiet}>Not set</span>;
  return [
    {
      key: 'value',
      label: 'Estimated value',
      value: moneyOrNull(o.value, o.currency, numberSystem) ?? dash,
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
  const numberSystem = await getNumberSystem();

  const [oppResult, activityResult, quotationsResult, peopleResult] = await Promise.allSettled([
    getOpportunity(session, id),
    listActivities(session, { opportunityId: id, status: 'logged', limit: 100 }),
    listQuotations(session, { opportunityId: id }),
    // Names for History's actor. Needs crm.lead.write; without it History just omits the name.
    listLeadOwners(session),
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
  const moves = userMoves('opportunity', opp.stage);
  const activityProblem =
    activityResult.status === 'rejected' ? failureOf(activityResult.reason) : null;
  const people = peopleById(peopleResult.status === 'fulfilled' ? peopleResult.value : []);
  const quotationProblem =
    quotationsResult.status === 'rejected' ? failureOf(quotationsResult.reason) : null;
  const quotations = quotationsResult.status === 'fulfilled' ? quotationsResult.value : [];
  const quotesHref = opportunityQuotationsHref(opp.id);
  const open = opp.stage !== 'lost' && opp.stage !== 'won';
  // A list that did not load falls back to New:
  // the New page checks again before it shows the builder.
  const entry: QuotationEntry = quotationEntryFor(quotations);
  const stages = OPPORTUNITY_STAGES.filter(
    (stage) => (stage !== 'lost' && stage !== 'on_hold') || stage === opp.stage,
  );

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
            entry.kind === 'resume' ? (
              <>
                <LinkButton href={quotesHref} variant="secondary">
                  View quotations
                </LinkButton>
                <LinkButton
                  href={editQuotationHref(entry.quotationId)}
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
                <LinkButton href={quotesHref}>Choose a draft ({entry.count})</LinkButton>
              </>
            ) : (
              <>
                <LinkButton href={quotesHref} variant="secondary">
                  View quotations
                </LinkButton>
                {open ? (
                  <LinkButton href={newQuotationHref(opp.id)}>New quotation</LinkButton>
                ) : null}
              </>
            )
          }
        />
      </div>

      <Card as="aside" aria-label="Stage" className={styles.stageCard}>
        <StatusTimeline
          label="Opportunity stages"
          steps={stages.map((stage) => ({
            key: stage,
            title: <span>{stageLabel('opportunity', stage)}</span>,
            status: stage === opp.stage ? 'Current' : '',
            tone: stage === opp.stage ? 'current' : 'upcoming',
          }))}
          className={styles.pipeline ?? ''}
        />
        {opp.stage !== 'won' ? (
          <div className={styles.stageControls}>
            {opp.stageReason ? (
              <div className={styles.reasonBox}>
                <strong>{opp.stageReason}</strong>
                {opp.stageNote ? <span>{opp.stageNote}</span> : null}
              </div>
            ) : null}
            {moves.length > 0 ? (
              <p className={styles.quiet}>Sending and accepting quotations update the stage.</p>
            ) : null}
            <MoveForm
              action={moveOpportunityStageAction}
              recordId={opp.id}
              version={opp.version}
              moves={moves}
              emptyText="A manager can reopen a lost opportunity."
            />
          </div>
        ) : null}
      </Card>

      <Panel title="Deal summary" className={styles.summary}>
        <FactList
          facts={facts(
            opp,
            customer ? `${customer.legalName} · ${customer.number}` : 'Customer name unavailable',
            numberSystem,
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
                    {money(quote.total, quote.currency, numberSystem)}
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

      <OpportunityActivities opportunityId={opp.id}>
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
            people={people}
            empty="Add a call, meeting, email or note for this opportunity."
          />
        )}
      </OpportunityActivities>
    </Page>
  );
}
