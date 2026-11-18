import { randomUUID } from 'node:crypto';

import {
  MemoTemplateSnapshotSchema,
  type ApprovalRequestDto,
  type InboxItemDto,
} from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import { QuotationApprovalSummary } from '@/components/p2/quotations/approval-summary';
import { Alert } from '@/components/ui/alert';
import { AuditActor } from '@/components/ui/audit-actor';
import { Button } from '@/components/ui/button';
import { FilePreviewDialog } from '@/components/ui/file-preview-dialog';
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

/** Resolve step labels from the authorized request. */
function stepWho(step: Step, names: Map<string, string>): string {
  if (step.assigneeUserId)
    return names.get(step.assigneeUserId.toLowerCase()) ?? 'Approver name unavailable';
  if (step.kind === 'role' && step.roleKey) return `Anyone with the ${step.roleKey} role`;
  if (step.kind === 'group' && step.groupId)
    return step.groupName ?? 'Approval group name unavailable';
  if (step.kind === 'user' && step.userId)
    return names.get(step.userId.toLowerCase()) ?? 'Approver name unavailable';
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

const FrozenAttachment = z.object({
  documentId: z.guid(),
  versionId: z.guid(),
  filename: z.string(),
  detectedMime: z.string().nullable(),
});

function memoAttachments(snapshot: unknown) {
  if (typeof snapshot !== 'object' || snapshot === null || !('attachments' in snapshot)) return [];
  if (!Array.isArray(snapshot.attachments)) return [];
  return snapshot.attachments.flatMap((raw: unknown) => {
    const file = FrozenAttachment.safeParse(raw);
    return file.success ? [file.data] : [];
  });
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
  const isMemo = request.documentType === 'test_memo';
  const attachments = isMemo ? memoAttachments(snapshot) : [];
  const memoTemplate = MemoTemplateSnapshotSchema.safeParse(
    isMemo && snapshot !== null && typeof snapshot === 'object' && 'template' in snapshot
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
  // Preserve the submitted memo's signer names if someone has since been renamed.
  const names = new Map(
    [
      ...(request.people ?? []),
      ...(memoTemplate.success ? [memoTemplate.data.preparedBy, ...selectedSigners] : []),
    ].map((person) => [person.userId.toLowerCase(), person.name]),
  );
  const person = (id: string) => <AuditActor id={id} name={names.get(id.toLowerCase())} />;
  const rows = snapshotEntries(snapshot).filter(
    (row) =>
      (!memoTemplate.success || row.key !== 'template') && (!isMemo || row.key !== 'attachments'),
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
    title: selectedSigners[step.seq - 1]?.name ?? stepWho(step, names),
    status: statusText(step.status),
    tone: STEP_TONE[step.status] ?? 'upcoming',
    detail: (
      <>
        {step.reason}
        {step.decidedBy ? (
          <>
            <br />
            Decided by {person(step.decidedBy)}
            {step.decidedOnBehalfOf ? <> for {person(step.decidedOnBehalfOf)}</> : null}
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
            </time> by {person(request.requesterUserId)}
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

      <div className={isMemo ? styles.main : styles.columns}>
        <div className={styles.main}>
          <Panel
            title="What was submitted"
            description="A frozen copy from the moment of submission. Later edits do not change it."
          >
            {request.documentType === 'quotation_version' ? (
              <QuotationApprovalSummary request={request} />
            ) : facts.length === 0 && !memoTemplate.success ? (
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

          {attachments.length > 0 ? (
            <Panel title="Attachments">
              <ul className={styles.frozenFiles}>
                {attachments.map((file) => {
                  const base = `/api/documents/${file.documentId}/versions/${file.versionId}`;
                  return (
                    <li key={file.versionId}>
                      <FilePreviewDialog
                        name={file.filename}
                        mimeType={file.detectedMime ?? 'application/octet-stream'}
                        previewUrl={`${base}/preview`}
                        downloadUrl={`${base}/download`}
                        trigger={<Button variant="secondary">{file.filename}</Button>}
                      />
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}

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
                        {person(a.actorUserId)}
                        {a.onBehalfOfUserId ? <> for {person(a.onBehalfOfUserId)}</> : null}
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

        <Panel
          as={isMemo ? 'section' : 'aside'}
          title="Your decision"
          className={isMemo ? undefined : styles.side}
        >
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
