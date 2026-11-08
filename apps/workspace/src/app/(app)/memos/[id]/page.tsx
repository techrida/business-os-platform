import { ALLOWED_MIME, type AuditEventDto, MAX_UPLOAD_BYTES, type RoutePlan } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { failureOf, getMemo, listAudit, previewRoute, type MemoDetail } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';
import { humanizeKey, toAttachmentView } from '@/lib/kernel-ui';

import { Notice, StatusBadge } from '../../kit';
import styles from '../../kit.module.css';
import { updateMemoAction } from '../actions';
import { MemoForm } from '../memo-form';
import { Attachments } from './attachments';
import { SubmitForm } from './submit-form';

export const metadata: Metadata = { title: 'Memo · Business OS' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ saved?: string | string[]; submitted?: string | string[] }>;

/** `test_memos.update` becomes `Test memos update`: the audit action names are dotted identifiers. */
const auditLabel = (action: string): string => humanizeKey(action);

function Timeline({ events }: { events: AuditEventDto[] }) {
  return (
    <ol className={styles.history}>
      {events.map((e) => (
        <li key={e.id} className={styles.event}>
          <div className={styles.eventHead}>
            <span className={styles.eventName}>{auditLabel(e.action)}</span>
            <span className={styles.meta}>
              {e.actorKind === 'user' ? `person ${e.actorId.slice(-8)}` : e.actorKind}
            </span>
            <time className={styles.eventTime} dateTime={e.occurredAt}>
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
  const submitted =
    query.submitted === 'pending' || query.submitted === 'blocked' ? query.submitted : null;

  let memo: MemoDetail;
  try {
    memo = await getMemo(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <main id="main" className={`${styles.page} ${styles.narrow}`}>
        <Link href="/memos" className={styles.back}>
          Back to memos
        </Link>
        <Notice tone="bad" role="alert">
          <p>
            <strong>
              {f.status === 403 ? 'You cannot open this memo' : 'This memo did not load'}
            </strong>
          </p>
          <p>{f.message}</p>
          {f.status !== 403 ? (
            <p>
              <a href={path}>Try again</a>
            </p>
          ) : null}
        </Notice>
      </main>
    );
  }

  // Only a draft or a returned memo can change; the API enforces it, the page just matches.
  const editable = memo.status === 'draft' || memo.status === 'returned';

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

  return (
    <main id="main" className={styles.page}>
      <Link href="/memos" className={styles.back}>
        Back to memos
      </Link>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>{memo.title}</h1>
          <p className={styles.sub}>
            {memo.number} · created <time dateTime={memo.createdAt}>{when(memo.createdAt)}</time>
          </p>
        </div>
        <StatusBadge status={memo.status} />
      </div>

      {saved || submitted !== null ? (
        <div style={{ marginBottom: '1rem' }}>
          {saved ? (
            <Notice tone="ok" role="status">
              <p>Your changes were saved.</p>
            </Notice>
          ) : submitted === 'blocked' ? (
            <Notice tone="warn" role="status">
              <p>
                <strong>Submitted, but it is blocked.</strong> No approver is available for a step
                of the route. An administrator can fix the route, then reroute it.
              </p>
            </Notice>
          ) : (
            <Notice tone="ok" role="status">
              <p>Submitted for approval. You will get a notification when it is decided.</p>
            </Notice>
          )}
        </div>
      ) : null}

      <div className={styles.split}>
        <div className={styles.stack}>
          <section className={styles.panel} aria-labelledby="memo-h">
            <h2 id="memo-h" className={styles.panelTitle}>
              Memo
            </h2>
            <dl className={styles.facts}>
              <dt>Amount</dt>
              <dd className={styles.amount} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {money(memo.amount, memo.currency)}
              </dd>
              {memo.currency !== 'NPR' ? (
                <>
                  <dt>In NPR</dt>
                  <dd style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {money(memo.amountNpr, 'NPR')}
                    <span className={styles.meta}>
                      {' '}
                      at {memo.fxRate} ({memo.fxSource}, {when(memo.fxDate, 'date')})
                    </span>
                  </dd>
                </>
              ) : null}
              <dt className={styles.wide}>Details</dt>
              <dd className={styles.wide}>
                {memo.body === '' ? (
                  <span className={styles.meta}>No details were written.</span>
                ) : (
                  <p className={styles.comment} style={{ margin: '0.25rem 0 0' }}>
                    {memo.body}
                  </p>
                )}
              </dd>
            </dl>
            {memo.approval ? (
              <p style={{ margin: '1rem 0 0' }}>
                <Link
                  href={`/inbox/${encodeURIComponent(memo.approval.requestId)}`}
                  className={styles.link}
                >
                  View the approval route and history
                </Link>
              </p>
            ) : null}
          </section>

          {editable ? (
            <section className={styles.panel} aria-labelledby="edit-h">
              <h2 id="edit-h" className={styles.panelTitle}>
                Edit memo
              </h2>
              <MemoForm
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
            </section>
          ) : null}

          <section className={styles.panel} aria-labelledby="att-h">
            <h2 id="att-h" className={styles.panelTitle}>
              Attachments
            </h2>
            <Attachments
              memoId={memo.id}
              initial={attachments}
              canUpload={editable}
              maxBytes={MAX_UPLOAD_BYTES}
              allowedMime={[...ALLOWED_MIME]}
            />
          </section>

          <section className={styles.panel} aria-labelledby="audit-h">
            <h2 id="audit-h" className={styles.panelTitle}>
              Audit timeline
            </h2>
            <p className={styles.panelNote}>Times are Kathmandu time.</p>
            {auditDenied && events.length === 0 ? (
              <p className={styles.meta} style={{ margin: 0 }}>
                The audit trail is only open to roles with audit access, so it is hidden for you.
              </p>
            ) : auditFailed && events.length === 0 ? (
              <Notice tone="warn" role="status">
                <p>The audit timeline did not load. The memo itself is unaffected.</p>
                <p>
                  <a href={path}>Reload</a>
                </p>
              </Notice>
            ) : events.length === 0 ? (
              <p className={styles.meta} style={{ margin: 0 }}>
                No events recorded yet.
              </p>
            ) : (
              <Timeline events={events} />
            )}
          </section>
        </div>

        <aside className={`${styles.panel} ${styles.sticky}`} aria-labelledby="route-h">
          <h2 id="route-h" className={styles.panelTitle}>
            {editable ? 'Approval route' : 'Status'}
          </h2>
          {editable ? (
            <>
              <p className={styles.panelNote}>
                This is who will be asked to approve, and why. It is worked out again when you
                submit.
              </p>
              {plan ? (
                <ol className={styles.steps} style={{ marginBottom: '1rem' }}>
                  {plan.steps.map((s) => (
                    <li key={s.seq} className={styles.step}>
                      <span className={styles.stepNo} aria-hidden="true">
                        {s.seq}
                      </span>
                      <div>
                        <div className={styles.stepHead}>
                          <span className={styles.stepWho}>
                            <span className={styles.visuallyHidden}>Step {s.seq}: </span>
                            {s.kind === 'role' && s.roleKey
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
                <div style={{ marginBottom: '1rem' }}>
                  <Notice tone="warn" role="status">
                    <p>
                      {previewFailure?.status === 403
                        ? 'You cannot preview the route with your roles. Submitting still works if you may submit.'
                        : 'The route preview did not load. You can still submit; the route is worked out then.'}
                    </p>
                  </Notice>
                </div>
              )}
              {plan?.blocked ? (
                <div style={{ marginBottom: '1rem' }}>
                  <Notice tone="warn">
                    <p>
                      <strong>
                        No one can approve step {plan.steps.find((s) => s.blocked)?.seq ?? ''} yet.
                      </strong>{' '}
                      {plan.blockReason ??
                        'Everyone eligible prepared this memo, so they cannot approve it.'}{' '}
                      You can still submit; it will wait as blocked until an administrator fixes the
                      route.
                    </p>
                  </Notice>
                </div>
              ) : null}
              <SubmitForm memoId={memo.id} blocker={submitBlocker} />
            </>
          ) : (
            <p className={styles.meta} style={{ margin: 0 }}>
              {memo.status === 'submitted'
                ? 'This memo is waiting for approval. It cannot be edited until it is returned.'
                : memo.status === 'approved'
                  ? 'This memo was approved.'
                  : 'This memo was rejected.'}
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}
