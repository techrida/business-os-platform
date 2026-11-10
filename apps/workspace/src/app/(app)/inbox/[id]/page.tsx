import { randomUUID } from 'node:crypto';

import {
  MemoTemplateSnapshotSchema,
  type ApprovalRequestDto,
  type InboxItemDto,
} from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { QuotationApprovalSummary } from '@/components/p2/quotations/approval-summary';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import {
  StatusTimeline,
  type TimelineStep,
  type TimelineTone,
} from '@/components/ui/status-timeline';
import { failureOf, getApprovalRequest, getInbox } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { snapshotEntries, when } from '@/lib/kernel-format';

import { StatusBadge, statusText } from '../../kit';
import { DecisionForm } from './decision-form';
import { MemoPaper } from '../../memos/memo-paper';
import styles from '../inbox.module.css';

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

type Step = ApprovalRequestDto['steps'][number];

/** Who a step belongs to, in words. Names are not available to staff without admin rights. */
function stepWho(step: Step): string {
  if (step.kind === 'role' && step.roleKey) return `Anyone with the ${step.roleKey} role`;
  if (step.kind === 'group' && step.groupId) return 'Assigned approval group';
  if (step.kind === 'user' && step.userId) return 'Assigned person';
  return `Step ${step.seq}`;
}

const STEP_TONE: Record<string, TimelineTone> = {
  waiting: 'upcoming',
  active: 'current',
  approved: 'done',
  returned: 'warning',
  rejected: 'error',
  skipped: 'muted',
};

function titleOf(snapshot: unknown): string | null {
  if (snapshot !== null && typeof snapshot === 'object' && 'title' in snapshot) {
    const t = snapshot.title;
    if (typeof t === 'string' && t !== '') return t;
  }
  return null;
}

function Person({ id: _id }: { id: string }) {
  return <span>a staff member</span>;
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
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Inbox', href: '/inbox' }, { label: 'Approval' }]} />
        <Alert
          tone="error"
          role="alert"
          title={f.status === 403 ? 'You cannot open this request' : 'This request did not load'}
          actions={f.status !== 403 ? <a href={path}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
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
  const snapshot = request.snapshot;
  const memoTemplate = MemoTemplateSnapshotSchema.safeParse(
    request.documentType === 'test_memo' &&
      snapshot !== null &&
      typeof snapshot === 'object' &&
      'template' in snapshot
      ? snapshot.template
      : null,
  );
  const memoBody =
    snapshot !== null &&
    typeof snapshot === 'object' &&
    'body' in snapshot &&
    typeof snapshot.body === 'string'
      ? snapshot.body
      : '';
  const selectedSigners = memoTemplate.success
    ? [...memoTemplate.data.recommenders, memoTemplate.data.approvedBy]
    : [];
  const rows = snapshotEntries(request.snapshot).filter(
    (row) => !memoTemplate.success || row.key !== 'template',
  );
  const inboxItem = items?.find((i) => i.requestId === request.requestId);

  const facts: Fact[] = rows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.block ? <pre className={styles.pre}>{row.value}</pre> : row.value,
    wide: row.block,
  }));

  const timeline: TimelineStep[] = request.steps.map((step) => ({
    key: step.seq,
    title: selectedSigners[step.seq - 1]?.name ?? stepWho(step),
    status: statusText(step.status),
    tone: STEP_TONE[step.status] ?? 'upcoming',
    detail: (
      <>
        {step.reason}
        {step.decidedBy ? (
          <>
            <br />
            Decided by <Person id={step.decidedBy} />
            {step.decidedOnBehalfOf ? (
              <>
                {' '}
                for <Person id={step.decidedOnBehalfOf} />
              </>
            ) : null}
          </>
        ) : null}
      </>
    ),
  }));

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Inbox', href: '/inbox' }, { label: title ?? request.documentNumber }]}
      />
      <PageHeader
        title={title ?? request.documentNumber}
        status={<StatusBadge status={request.status} />}
        description={
          <>
            {title !== null ? `${request.documentNumber} · ` : ''}
            Submitted <time dateTime={request.submittedAt}>
              {when(request.submittedAt)}
            </time> by <Person id={request.requesterUserId} />
          </>
        }
      />

      {request.blockReason ? (
        <Alert tone="warning" title="This request is blocked.">
          {request.blockReason}
        </Alert>
      ) : null}

      {inboxItem ? (
        <Alert
          tone="info"
          role="region"
          aria-label="Why this is in your inbox"
          title="Why this is in your inbox"
        >
          {inboxItem.reason}
        </Alert>
      ) : null}

      <Panel
        title="Approval route"
        description="Each step must approve before the next one starts."
      >
        <StatusTimeline label="Approval route steps" steps={timeline} />
      </Panel>

      <div className={styles.columns}>
        <div className={styles.main}>
          <Panel
            title="What was submitted"
            description="A frozen copy from the moment of submission. Later edits do not change it."
          >
            {request.documentType === 'quotation_version' ? (
              <QuotationApprovalSummary request={request} />
            ) : facts.length === 0 ? (
              <p className={styles.note}>The snapshot is empty.</p>
            ) : (
              <>
                {memoTemplate.success ? (
                  <MemoPaper
                    template={memoTemplate.data}
                    title={title ?? request.documentNumber}
                    body={memoBody}
                  />
                ) : null}
                <FactList facts={facts} />
              </>
            )}
          </Panel>

          <Panel title="History">
            {request.actions.length === 0 ? (
              <p className={styles.note}>Nothing has happened yet.</p>
            ) : (
              <ol className={styles.history}>
                {request.actions.map((a, i) => (
                  <li key={`${a.createdAt}-${i}`} className={styles.event}>
                    <div className={styles.eventHead}>
                      <span className={styles.eventName}>{ACTION_LABEL[a.action] ?? a.action}</span>
                      <span className={styles.eventMeta}>
                        <Person id={a.actorUserId} />
                        {a.onBehalfOfUserId ? (
                          <>
                            {' '}
                            for <Person id={a.onBehalfOfUserId} />
                          </>
                        ) : null}
                      </span>
                      <time className={styles.eventMeta} dateTime={a.createdAt}>
                        {when(a.createdAt)}
                      </time>
                    </div>
                    {a.comment ? <p className={styles.comment}>{a.comment}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <Panel as="aside" title="Your decision" className={styles.side}>
          {waitingOnMe === 'no' ? (
            <p className={styles.note}>
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
        </Panel>
      </div>
    </Page>
  );
}
