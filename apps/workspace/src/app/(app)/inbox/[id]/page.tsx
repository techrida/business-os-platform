import { randomUUID } from 'node:crypto';

import type { ApprovalRequestDto, InboxItemDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { failureOf, getApprovalRequest, getInbox } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { snapshotEntries, when } from '@/lib/kernel-format';
import { shortId } from '@/lib/kernel-ui';

import { Notice, StatusBadge } from '../../kit';
import styles from '../../kit.module.css';
import { DecisionForm } from './decision-form';

export const metadata: Metadata = { title: 'Approval · Business OS' };
export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = {
  submit: 'Submitted',
  approve: 'Approved',
  return: 'Returned for changes',
  reject: 'Rejected',
  escalate: 'Escalated after the deadline',
  remind: 'Reminder sent',
  block: 'Blocked: no approver available',
  reroute: 'Route recalculated',
};

/** Who a step belongs to, in words. Names are not available to staff without admin rights. */
function stepWho(step: ApprovalRequestDto['steps'][number]): string {
  if (step.kind === 'role' && step.roleKey) return `Anyone with the ${step.roleKey} role`;
  if (step.kind === 'group' && step.groupId) return `Approval group ${shortId(step.groupId)}`;
  if (step.kind === 'user' && step.userId) return `Person ${shortId(step.userId)}`;
  return `Step ${step.seq}`;
}

function titleOf(snapshot: unknown): string | null {
  if (snapshot !== null && typeof snapshot === 'object' && 'title' in snapshot) {
    const t = snapshot.title;
    if (typeof t === 'string' && t !== '') return t;
  }
  return null;
}

export default async function InboxDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const path = `/inbox/${encodeURIComponent(id)}`;
  const session = await requireStaffSession(path);

  // The inbox tells us whether this request is waiting on this person; the detail call alone
  // cannot (a requester can read their own request but not decide it).
  const [detail, inbox] = await Promise.allSettled([
    getApprovalRequest(session, id),
    getInbox(session),
  ]);

  if (detail.status === 'rejected') {
    const f = failureOf(detail.reason);
    if (f.status === 404) notFound();
    return (
      <main id="main" className={`${styles.page} ${styles.narrow}`}>
        <Link href="/inbox" className={styles.back}>
          Back to the inbox
        </Link>
        <Notice tone="bad" role="alert">
          <p>
            <strong>
              {f.status === 403 ? 'You cannot open this request' : 'This request did not load'}
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

  const request = detail.value;
  const items: InboxItemDto[] | null = inbox.status === 'fulfilled' ? inbox.value : null;
  const inboxDenied = inbox.status === 'rejected' && failureOf(inbox.reason).status === 403;
  // `yes` when the inbox lists it, `no` when it does not (or the person has no approval rights),
  // `unknown` when the inbox itself failed: then the form shows and the API decides.
  const waitingOnMe: 'yes' | 'no' | 'unknown' =
    request.status !== 'pending'
      ? 'no'
      : items !== null
        ? items.some((i) => i.requestId === request.requestId)
          ? 'yes'
          : 'no'
        : inboxDenied
          ? 'no'
          : 'unknown';

  const title = titleOf(request.snapshot);
  const rows = snapshotEntries(request.snapshot);
  const inboxItem = items?.find((i) => i.requestId === request.requestId);

  return (
    <main id="main" className={styles.page}>
      <Link href="/inbox" className={styles.back}>
        Back to the inbox
      </Link>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>{title ?? request.documentNumber}</h1>
          <p className={styles.sub}>
            {title !== null ? `${request.documentNumber} · ` : ''}
            Submitted <time dateTime={request.submittedAt}>
              {when(request.submittedAt)}
            </time> by{' '}
            <span title={request.requesterUserId}>person {shortId(request.requesterUserId)}</span>
          </p>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {request.blockReason ? (
        <div className={styles.stack} style={{ marginBottom: '1rem' }}>
          <Notice tone="warn">
            <p>
              <strong>This request is blocked.</strong> {request.blockReason}
            </p>
          </Notice>
        </div>
      ) : null}

      <div className={styles.split}>
        <div className={styles.stack}>
          {inboxItem ? (
            <section className={styles.panel} aria-labelledby="why-h">
              <h2 id="why-h" className={styles.panelTitle}>
                Why this is in your inbox
              </h2>
              <p style={{ margin: 0 }}>{inboxItem.reason}</p>
            </section>
          ) : null}

          <section className={styles.panel} aria-labelledby="snap-h">
            <h2 id="snap-h" className={styles.panelTitle}>
              What was submitted
            </h2>
            <p className={styles.panelNote}>
              A frozen copy from the moment of submission. Later edits do not change it.
            </p>
            {rows.length === 0 ? (
              <p className={styles.meta}>The snapshot is empty.</p>
            ) : (
              <dl className={styles.facts}>
                {rows.map((row) => (
                  <div key={row.key} style={{ display: 'contents' }}>
                    <dt className={row.block ? styles.wide : undefined}>{row.label}</dt>
                    <dd className={row.block ? styles.wide : undefined}>
                      {row.block ? <pre className={styles.pre}>{row.value}</pre> : row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          <section className={styles.panel} aria-labelledby="route-h">
            <h2 id="route-h" className={styles.panelTitle}>
              Approval route
            </h2>
            <ol className={styles.steps}>
              {request.steps.map((step) => (
                <li key={step.seq} className={styles.step}>
                  <span className={styles.stepNo} aria-hidden="true">
                    {step.seq}
                  </span>
                  <div>
                    <div className={styles.stepHead}>
                      <span className={styles.stepWho}>
                        <span className={styles.visuallyHidden}>Step {step.seq}: </span>
                        {stepWho(step)}
                      </span>
                      <StatusBadge status={step.status} />
                    </div>
                    <p className={styles.stepReason}>{step.reason}</p>
                    {step.decidedBy ? (
                      <p className={styles.meta} style={{ margin: '0.125rem 0 0' }}>
                        Decided by{' '}
                        <span title={step.decidedBy}>person {shortId(step.decidedBy)}</span>
                        {step.decidedOnBehalfOf ? (
                          <>
                            {' '}
                            for{' '}
                            <span title={step.decidedOnBehalfOf}>
                              person {shortId(step.decidedOnBehalfOf)}
                            </span>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.panel} aria-labelledby="hist-h">
            <h2 id="hist-h" className={styles.panelTitle}>
              History
            </h2>
            {request.actions.length === 0 ? (
              <p className={styles.meta}>Nothing has happened yet.</p>
            ) : (
              <ol className={styles.history}>
                {request.actions.map((a, i) => (
                  <li key={`${a.createdAt}-${i}`} className={styles.event}>
                    <div className={styles.eventHead}>
                      <span className={styles.eventName}>{ACTION_LABEL[a.action] ?? a.action}</span>
                      <span className={styles.meta}>
                        <span title={a.actorUserId}>person {shortId(a.actorUserId)}</span>
                        {a.onBehalfOfUserId ? (
                          <>
                            {' '}
                            for{' '}
                            <span title={a.onBehalfOfUserId}>
                              person {shortId(a.onBehalfOfUserId)}
                            </span>
                          </>
                        ) : null}
                      </span>
                      <time className={styles.eventTime} dateTime={a.createdAt}>
                        {when(a.createdAt)}
                      </time>
                    </div>
                    {a.comment ? <p className={styles.comment}>{a.comment}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className={`${styles.panel} ${styles.sticky}`} aria-labelledby="decide-h">
          <h2 id="decide-h" className={styles.panelTitle}>
            Your decision
          </h2>
          {waitingOnMe === 'no' ? (
            <p className={styles.meta} style={{ margin: 0 }}>
              {request.status === 'pending'
                ? 'This request is not waiting on you right now. You can read it, but you cannot decide it.'
                : 'This request has been decided, so there is nothing left to do.'}
            </p>
          ) : (
            <DecisionForm
              requestId={request.requestId}
              version={request.version}
              // One key per render of this page: a double click or a retry after a network
              // error sends the same key, so the decision is applied once.
              idempotencyKey={randomUUID()}
              reloadHref={path}
            />
          )}
        </aside>
      </div>
    </main>
  );
}
