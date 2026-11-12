import { ALLOWED_MIME, type AuditEventDto, MAX_UPLOAD_BYTES, type RoutePlan } from '@bos/contracts';
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
  listAudit,
  previewRoute,
  type MemoDetail,
} from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';
import { humanizeKey, toAttachmentView } from '@/lib/kernel-ui';

import { StatusBadge } from '../../kit';
import styles from '../../kit.module.css';
import { updateMemoAction } from '../actions';
import { MemoForm } from '../memo-form';
import { MemoPreview } from '../memo-preview';
import { Attachments } from './attachments';
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

function Timeline({ events }: { events: AuditEventDto[] }) {
  return (
    <ol className={styles.history}>
      {events.map((e) => (
        <li key={e.id} className={styles.event}>
          <div className={styles.eventHead}>
            <span className={styles.eventName}>{auditLabel(e.action)}</span>
            <span className={styles.eventMeta}>
              {e.actorKind === 'user' ? 'Staff member' : e.actorKind}
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
  const editable = memo.status === 'draft' || memo.status === 'returned';
  const directory =
    editable && memo.template ? await getMemoDirectory(session).catch(() => undefined) : undefined;

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
  const notClean = attachments.filter((a) => a.status !== 'clean');
  const scanning = notClean.filter(
    (a) => a.status === 'quarantined' || a.status === 'awaiting_content',
  );
  const submitBlocker =
    scanning.length > 0
      ? `Waiting for ${scanning.length} attachment${scanning.length === 1 ? '' : 's'} to finish scanning. This page updates by itself.`
      : notClean.length > 0
        ? 'An attachment did not pass the scan, so this memo cannot be submitted.'
        : null;

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

      {attachHint ? (
        <Alert tone="success" role="status" title="Draft saved.">
          Attach your files below. Each one is scanned before anyone can download it, and the memo
          can be submitted once they are clean.
        </Alert>
      ) : saved ? (
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
                initial={{
                  title: memo.title,
                  body: memo.body,
                  amount: memo.amount,
                  currency: memo.currency,
                }}
              />
            </Panel>
          ) : null}

          <Panel title="Attachments" id="attachments">
            <Attachments
              memoId={memo.id}
              initial={attachments}
              canUpload={editable}
              maxBytes={MAX_UPLOAD_BYTES}
              allowedMime={[...ALLOWED_MIME]}
            />
          </Panel>

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
              <Timeline events={events} />
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
              <SubmitForm memoId={memo.id} blocker={submitBlocker} />
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
