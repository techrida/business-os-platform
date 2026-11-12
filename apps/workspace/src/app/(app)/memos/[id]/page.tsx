import type { AuditEventDto, RoutePlan } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import {
  failureOf,
  getMemoDirectory,
  getMemo,
  getMemoRoute,
  listAudit,
  type MemoDetail,
} from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';
import { userNames } from '@/lib/business-labels';
import { humanizeKey, toAttachmentView } from '@/lib/kernel-ui';

import { StatusBadge } from '../../kit';
import styles from '../../kit.module.css';
import { updateMemoAction } from '../actions';
import { MemoForm } from '../memo-form';
import { MemoPreview } from '../memo-preview';
import { HistoricalAttachments } from './historical-attachments';
import { SubmitForm } from './submit-form';

export const metadata: Metadata = { title: 'Memo · Business OS' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  saved?: string | string[];
  submitted?: string | string[];
}>;

/** Present the historical test-memo action namespace using the product document name. */
const auditLabel = (action: string): string =>
  humanizeKey(action.replace(/^test_memos[.]/, 'memo.'));

function Timeline({ events, people }: { events: AuditEventDto[]; people: Map<string, string> }) {
  return (
    <ol className={styles.history}>
      {events.map((e) => (
        <li key={e.id} className={styles.event}>
          <div className={styles.eventHead}>
            <span className={styles.eventName}>{auditLabel(e.action)}</span>
            <span className={styles.eventMeta}>
              {e.actorKind === 'user'
                ? (people.get(e.actorId) ?? 'Person name unavailable')
                : e.actorKind}
            </span>
            <time className={styles.eventMeta} dateTime={e.occurredAt}>
              {when(e.occurredAt)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default async function MemoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const path = `/memos/${encodeURIComponent(id)}`;
  const session = await requireStaffSession(path);
  const query = await searchParams;
  const people = await userNames(session);
  const saved = query.saved === '1';
  const submitted =
    query.submitted === 'pending' || query.submitted === 'blocked' ? query.submitted : null;

  let memo: MemoDetail;
  try {
    memo = await getMemo(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Memos', href: '/memos' }, { label: 'Memo' }]} />
        <Alert
          tone="error"
          role="alert"
          title={f.status === 403 ? 'You cannot open this memo' : 'This memo did not load'}
          actions={f.status !== 403 ? <a href={path}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  // Only a draft or a returned memo can change; the API enforces it, the page just matches.
  const editable = memo.status === 'draft' || memo.status === 'returned';
  const directory =
    editable && memo.template ? await getMemoDirectory(session).catch(() => undefined) : undefined;

  // The API builds this route with the same people and the same separation-of-duties list as submit, so
  // it shows what submit will create: for an internal memo, the people the author selected, in order.
  const entityIds = [memo.id, ...(memo.approval ? [memo.approval.requestId] : [])];
  const [previewResult, ...auditResults] = await Promise.allSettled([
    editable ? getMemoRoute(session, memo.id) : Promise.resolve(null as RoutePlan | null),
    ...entityIds.map((entityId) => listAudit(session, { entityId, limit: 50 })),
  ]);

  const plan = previewResult?.status === 'fulfilled' ? previewResult.value : null;
  const previewFailure =
    previewResult?.status === 'rejected' ? failureOf(previewResult.reason) : null;

  const auditOk = auditResults.filter(
    (r): r is PromiseFulfilledResult<AuditEventDto[]> => r.status === 'fulfilled',
  );
  const auditDenied = auditResults.some(
    (r) => r.status === 'rejected' && failureOf(r.reason).status === 403,
  );
  const auditFailed = auditResults.some(
    (r) => r.status === 'rejected' && failureOf(r.reason).status !== 403,
  );
  const events = auditOk
    .flatMap((r) => r.value)
    // Newest first; ids are bigint strings, so compare by time and break ties on length then text.
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) ||
        b.id.length - a.id.length ||
        b.id.localeCompare(a.id),
    );

  // Internal memos take no uploads. A memo from P1 may still carry files: shown read-only, never scanned here.
  const attachments = memo.attachments.map(toAttachmentView);
  // The amount columns hold NPR 0.00 for an internal memo. A nonzero value is a P1 test amount, shown as a record.
  const recordedAmount = Number(memo.amount) !== 0 || Number(memo.amountNpr) !== 0;
  const routePeople = memo.template
    ? [...memo.template.recommenders, memo.template.approvedBy]
    : [];

  const facts: Fact[] = [
    ...(recordedAmount
      ? [
          {
            key: 'amount',
            label: 'Recorded P1 test amount',
            value: (
              <>
                <span className={styles.amount}>{money(memo.amount, memo.currency)}</span>
                {memo.currency !== 'NPR' ? (
                  <span className={styles.caption}>
                    {money(memo.amountNpr, 'NPR')} at {memo.fxRate} ({memo.fxSource},{' '}
                    {when(memo.fxDate, 'date')})
                  </span>
                ) : null}
                <span className={styles.caption}>
                  Kept from the Phase 1 test memo. Nothing routes on it.
                </span>
              </>
            ),
          },
        ]
      : []),
    {
      key: 'details',
      label: 'Details',
      wide: true,
      value:
        memo.body === '' ? (
          <span className={styles.note}>No details were written.</span>
        ) : (
          <span className={styles.comment}>{memo.body}</span>
        ),
    },
  ];

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Memos', href: '/memos' }, { label: memo.title }]} />
      <PageHeader
        title={memo.title}
        status={<StatusBadge status={memo.status} />}
        description={
          <>
            {memo.number} · created <time dateTime={memo.createdAt}>{when(memo.createdAt)}</time>
          </>
        }
      />

      {saved ? (
        <Alert tone="success" role="status">
          Your changes were saved.
        </Alert>
      ) : submitted === 'blocked' ? (
        <Alert tone="warning" role="status" title="Submitted, but it is blocked.">
          No approver is available for a step of the route. An administrator can fix the route, then
          reroute it.
        </Alert>
      ) : submitted === 'pending' ? (
        <Alert tone="success" role="status">
          Submitted for approval. You will get a notification when it is decided.
        </Alert>
      ) : null}

      <div className={styles.columns}>
        <div className={styles.main}>
          <Panel
            title="Memo"
            actions={
              memo.approval ? (
                <Link
                  href={`/inbox/${encodeURIComponent(memo.approval.requestId)}`}
                  className={styles.link}
                >
                  View the approval route and history
                </Link>
              ) : null
            }
          >
            {memo.template ? (
              <MemoPreview
                template={memo.template}
                title={memo.title}
                body={memo.body}
                source={{ kind: 'saved', memoId: memo.id }}
                noun="memo"
              />
            ) : null}
            <FactList facts={facts} />
          </Panel>

          {editable && (!memo.template || directory) ? (
            <Panel title="Edit memo">
              <MemoForm
                directory={directory}
                template={memo.template}
                action={updateMemoAction}
                memoId={memo.id}
                submitLabel="Save changes"
                initial={{ title: memo.title, body: memo.body }}
              />
            </Panel>
          ) : null}

          {attachments.length > 0 ? (
            <Panel
              title="Attachments"
              description="Files attached in Phase 1. New files cannot be added to a memo."
              id="attachments"
            >
              <HistoricalAttachments files={attachments} />
            </Panel>
          ) : null}

          <Panel title="Audit timeline" description="Times are Kathmandu time.">
            {auditDenied && events.length === 0 ? (
              <p className={styles.note}>
                The audit trail is only open to roles with audit access, so it is hidden for you.
              </p>
            ) : auditFailed && events.length === 0 ? (
              <Alert tone="warning" role="status" actions={<a href={path}>Reload</a>}>
                The audit timeline did not load. The memo itself is unaffected.
              </Alert>
            ) : events.length === 0 ? (
              <p className={styles.note}>No events recorded yet.</p>
            ) : (
              <Timeline events={events} people={people} />
            )}
          </Panel>
        </div>

        <Panel
          as="aside"
          title="Approval route"
          description={
            editable
              ? 'This is who will be asked to approve, and why. It is worked out again when you submit.'
              : undefined
          }
          className={styles.side}
        >
          {editable ? (
            <div className={styles.routeBody}>
              {plan ? (
                <ol className={styles.steps}>
                  {plan.steps.map((s) => (
                    <li key={s.seq} className={styles.step}>
                      <span className={styles.stepNo} aria-hidden="true">
                        {s.seq}
                      </span>
                      <div className={styles.stepBody}>
                        <div className={styles.stepHead}>
                          <span className={styles.stepWho}>
                            <span className="sr-only">Step {s.seq}: </span>
                            {s.kind === 'user' &&
                            routePeople.find((p) => p.userId === s.userId) !== undefined
                              ? routePeople.find((p) => p.userId === s.userId)!.name
                              : s.kind === 'role' && s.roleKey
                                ? `Anyone with the ${s.roleKey} role`
                                : s.kind === 'group'
                                  ? 'An approval group'
                                  : 'A named person'}
                          </span>
                          {s.blocked ? <StatusBadge status="blocked" /> : null}
                        </div>
                        <p className={styles.stepReason}>{s.reason}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <Alert tone="warning" role="status">
                  {previewFailure?.status === 403
                    ? 'You cannot preview the route with your roles. Submitting still works if you may submit.'
                    : 'The route preview did not load. You can still submit; the route is worked out then.'}
                </Alert>
              )}
              {plan?.blocked ? (
                memo.template ? (
                  <Alert
                    tone="warning"
                    title={`Step ${plan.steps.find((s) => s.blocked)?.seq ?? ''} cannot approve this memo.`}
                  >
                    {plan.blockReason ?? 'A person you selected cannot approve this memo.'} Edit the
                    memo and choose different people; it cannot be submitted until then.
                  </Alert>
                ) : (
                  <Alert
                    tone="warning"
                    title={`No one can approve step ${plan.steps.find((s) => s.blocked)?.seq ?? ''} yet.`}
                  >
                    {plan.blockReason ??
                      'Everyone eligible prepared this memo, so they cannot approve it.'}{' '}
                    You can still submit; it will wait as blocked until an administrator fixes the
                    route.
                  </Alert>
                )
              ) : null}
              <SubmitForm memoId={memo.id} blocked={Boolean(memo.template && plan?.blocked)} />
            </div>
          ) : (
            <p className={styles.note}>
              {memo.status === 'submitted'
                ? 'This memo is waiting for approval. It cannot be edited until it is returned.'
                : memo.status === 'approved'
                  ? 'This memo was approved.'
                  : 'This memo was rejected.'}
            </p>
          )}
        </Panel>
      </div>
    </Page>
  );
}
