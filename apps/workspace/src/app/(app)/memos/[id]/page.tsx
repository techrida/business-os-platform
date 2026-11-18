import { ALLOWED_MIME, type AuditEventDto, MAX_UPLOAD_BYTES, type RoutePlan } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { actorLabel } from '@/components/ui/audit-actor';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import {
  failureOf,
  getMemoDirectory,
  getMemo,
  listAudit,
  previewRoute,
  type MemoDetail,
} from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';
import { humanizeKey, toAttachmentView } from '@/lib/kernel-ui';
import { memoDraftAccount } from '@/lib/memo-working-draft';

import styles from '../../kit.module.css';
import { updateMemoAction } from '../actions';
import { MemoForm } from '../memo-form';
import pageStyles from '../memo-pages.module.css';
import { MemoPreview } from '../memo-preview';
import { MemoReviewGate } from '../memo-review-gate';
import { MemoStatus } from '../memo-status';
import { Attachments } from './attachments';
import { submitMissing } from './detail-model';
import { MemoFeedback } from './memo-feedback';
import { SubmitForm } from './submit-form';

export const metadata: Metadata = { title: 'Memo · Business OS' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  saved?: string | string[];
  submitted?: string | string[];
  attach?: string | string[];
}>;

/** `test_memos.update` becomes `Test memos update`: the audit action names are dotted identifiers. */
const auditLabel = (action: string): string => humanizeKey(action);

const MEMO_CONTEXT = {
  draft: 'This memo is a draft.',
  submitted: 'This memo is waiting for approval. It can be edited if it is returned.',
  approved: 'This memo was approved.',
  returned: 'This memo was returned for changes.',
  rejected: 'This memo was rejected.',
};

function Timeline({ events }: { events: AuditEventDto[] }) {
  return (
    <ol className={styles.history}>
      {events.map((e) => (
        <li key={e.id} className={styles.event}>
          <div className={styles.eventHead}>
            <span className={styles.eventName}>{auditLabel(e.action)}</span>
            <span className={styles.eventMeta}>
              {actorLabel({ name: e.actorDisplayName, id: e.actorId, kind: e.actorKind })}
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
  const saved = query.saved === '1';
  const attachHint = query.attach === '1';
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
  const editable = memo.canUpdate;
  const directory =
    editable && memo.template ? await getMemoDirectory(session).catch(() => undefined) : undefined;

  // With an editor that has its own live preview, the saved render and fact list would only repeat it.
  const showEditor = editable && (!memo.template || directory !== undefined);
  const showMemoPanel = !(showEditor && memo.template);

  // The preview uses the same separation-of-duties list as the submit call (owner and editors),
  // so it shows the route submit will actually build, not the viewer's own.
  const entityIds = [memo.id, ...(memo.approval ? [memo.approval.requestId] : [])];
  const [previewResult, ...auditResults] = await Promise.allSettled([
    editable
      ? previewRoute(session, {
          documentType: 'test_memo',
          facts: { amountNpr: memo.amountNpr },
          sodUserIds: [memo.ownerUserId, ...memo.editorUserIds],
        })
      : Promise.resolve(null as RoutePlan | null),
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

  const attachments = memo.attachments.map(toAttachmentView);
  const missing = submitMissing(attachments);

  const facts: Fact[] = [
    {
      key: 'amount',
      label: 'Amount',
      value: <span className={styles.amount}>{money(memo.amount, memo.currency)}</span>,
    },
    ...(memo.currency !== 'NPR'
      ? [
          {
            key: 'npr',
            label: 'In NPR',
            value: (
              <>
                <span className={styles.amount}>{money(memo.amountNpr, 'NPR')}</span>
                <span className={styles.caption}>
                  at {memo.fxRate} ({memo.fxSource}, {when(memo.fxDate, 'date')})
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

  const editor = showEditor ? (
    <MemoForm
      directory={directory}
      template={memo.template}
      action={updateMemoAction}
      memoId={memo.id}
      memoVersion={memo.version}
      draftAccount={memoDraftAccount(session)}
      initial={{
        title: memo.title,
        body: memo.body,
        amount: memo.amount,
        currency: memo.currency,
      }}
    />
  ) : null;

  return (
    <MemoReviewGate>
      <Page className={pageStyles.detail}>
        <Breadcrumb items={[{ label: 'Memos', href: '/memos' }, { label: memo.number }]} />
        <PageHeader
          title={memo.title}
          status={
            memo.approval?.status === 'blocked' ? (
              <Badge tone="error">Blocked</Badge>
            ) : (
              <MemoStatus status={memo.status} />
            )
          }
          description={
            <>
              {memo.number} · created <time dateTime={memo.createdAt}>{when(memo.createdAt)}</time>
            </>
          }
          actions={
            editable ? (
              <SubmitForm memoId={memo.id} version={memo.version} missing={missing} />
            ) : undefined
          }
        />

        {attachHint || saved || submitted === 'pending' ? (
          <MemoFeedback notice={attachHint ? 'attach' : saved ? 'saved' : 'submitted'} />
        ) : null}
        {submitted === 'blocked' ? (
          <Alert tone="warning" role="status" title="Approval blocked">
            No approver is available for a step of the route. An administrator can update the route
            and reroute the memo.
          </Alert>
        ) : null}

        {showEditor && memo.template ? editor : null}
        <div className={pageStyles.columns}>
          <div className={pageStyles.main}>
            {showMemoPanel ? (
              <Panel title="Memo" className={pageStyles.detailPanel}>
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
            ) : null}

            {showEditor && !memo.template ? editor : null}

            {editable || attachments.length > 0 ? (
              <Panel
                title="Attachments"
                id="attachments"
                className={pageStyles.detailPanel}
                description={
                  editable
                    ? 'Files are scanned before they can be opened or submitted for approval.'
                    : undefined
                }
              >
                <Attachments
                  memoId={memo.id}
                  initial={attachments}
                  canUpload={editable}
                  maxBytes={MAX_UPLOAD_BYTES}
                  allowedMime={[...ALLOWED_MIME]}
                />
              </Panel>
            ) : null}
          </div>

          <Panel
            title="Approval route"
            className={`${pageStyles.detailPanel} ${pageStyles.route}`}
            description={editable ? 'The route is recalculated when you submit.' : undefined}
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
                              {memo.template &&
                              [...memo.template.recommenders, memo.template.approvedBy][s.seq - 1]
                                ? [...memo.template.recommenders, memo.template.approvedBy][
                                    s.seq - 1
                                  ]!.name
                                : s.kind === 'role' && s.roleKey
                                  ? `Anyone with the ${s.roleKey} role`
                                  : s.kind === 'group'
                                    ? 'An approval group'
                                    : 'A named person'}
                            </span>
                            {s.blocked ? <Badge tone="error">Blocked</Badge> : null}
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
                  <Alert
                    tone="warning"
                    title={`No one can approve step ${plan.steps.find((s) => s.blocked)?.seq ?? ''} yet.`}
                  >
                    {plan.blockReason ??
                      'Everyone eligible prepared this memo, so they cannot approve it.'}{' '}
                    You can still submit; it will wait as blocked until an administrator fixes the
                    route.
                  </Alert>
                ) : null}
              </div>
            ) : (
              <p className={styles.note}>
                {memo.approval?.status === 'blocked'
                  ? 'Approval is blocked. An administrator can update the approval route.'
                  : MEMO_CONTEXT[memo.status]}
              </p>
            )}
          </Panel>

          <Panel
            title="Audit timeline"
            description="Times are Kathmandu time."
            className={`${pageStyles.detailPanel} ${pageStyles.history}`}
          >
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
              <Timeline events={events} />
            )}
          </Panel>
        </div>
      </Page>
    </MemoReviewGate>
  );
}
