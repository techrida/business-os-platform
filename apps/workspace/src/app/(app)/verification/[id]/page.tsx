import { randomUUID } from 'node:crypto';

import {
  ALLOWED_MIME,
  MAX_UPLOAD_BYTES,
  type CustomerDto,
  type VerificationCaseDto,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import { getVerificationReviewHistory, getDocument } from '@/components/p2/crm/verification-api';
import { fileOf, type FileView } from '@/components/p2/crm/verification-file';
import { getCustomer, getVerificationCase } from '@/components/p2/customers/api';
import {
  type ApprovalFile,
  approvalFile,
  approvalProblems,
  canReject,
  CHECKLIST_LABEL,
  CHECKLIST_STATUS,
  checklistProgress,
  customerLabel,
  isGuid,
  VERIFICATION_STATUS_LABEL,
} from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { scanLabel } from '@/lib/kernel-ui';
import { when } from '@/lib/kernel-format';

import { CheckMark, ChecklistFile } from './checklist-file';
import { ReviewForm } from './review-form';
import { ItemReview, RemoveLoose } from './item-review';
import { SubmitForm } from '../submit-form';
import styles from '../verification.module.css';

export const metadata: Metadata = { title: 'Verification case · Business OS' };
export const dynamic = 'force-dynamic';

const ITEM_STATUS = {
  ...CHECKLIST_STATUS,
  provided: { tone: 'info', text: 'Pending' },
} as const;

function missingForSubmit(c: VerificationCaseDto): string[] {
  const required = c.checklist.filter((item) => item.required);
  if (required.length === 0) return ['At least one required document'];
  return c.checklist.flatMap((item) => {
    if (item.status === 'rejected') return [`${CHECKLIST_LABEL[item.key]}: replace the file`];
    return item.required && !item.documentId ? [CHECKLIST_LABEL[item.key]] : [];
  });
}

export default async function VerificationCasePage({
  params,
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
  params: Promise<{ id: string }>;
}) {
  const { before } = await searchParams;
  const { id } = await params;
  // An id that is not a GUID cannot be a case, so it never reaches the API.
  if (!isGuid(id)) notFound();
  const path = `/verification/${id}`;
  const session = await requireStaffSession(path);

  let c: VerificationCaseDto;
  try {
    c = await getVerificationCase(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Verification', href: '/verification' }, { label: 'Case' }]} />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open this case' : 'This case did not load'}
          actions={f.status !== 403 ? <a href={path}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  // The customer record adds its number and PAN/VAT; a failed lookup leaves the case working. A vendor case has no
  // customer record to read: its name comes with the case.
  let customer: CustomerDto | undefined;
  try {
    customer = c.partyKind === 'vendor' ? undefined : await getCustomer(session, c.partyId);
  } catch {
    customer = undefined;
  }
  // Each attached file is looked up on its own: one refusal (the reviewer may not read it) or one
  // failure leaves the other rows and the decision form working. No signed link is issued here;
  // it is issued by the download route when the link is clicked.
  const documentIds = [...new Set(c.checklist.flatMap((item) => item.documentId ?? []))];
  const lookups = await Promise.allSettled(documentIds.map((d) => getDocument(session, d)));
  const files = new Map<string, FileView | null>();
  const approvalFiles = new Map<string, ApprovalFile>();
  lookups.forEach((r, i) => {
    const documentId = documentIds[i];
    if (documentId === undefined) return;
    const bound = c.checklist.find((item) => item.documentId === documentId)?.evidence
      ?.documentVersionId;
    const document =
      r.status === 'fulfilled' &&
      r.value.id === documentId &&
      r.value.ownerType === 'verification_case' &&
      r.value.ownerId === c.id
        ? r.value
        : null;
    const needsBinding = c.reviewPolicy === 'document_review_v1' && c.status === 'submitted';
    if (!document || (needsBinding && !bound)) {
      approvalFiles.set(documentId, 'unavailable');
      files.set(documentId, null);
      return;
    }
    approvalFiles.set(documentId, approvalFile(document.versions, bound));
    files.set(documentId, fileOf(document, bound));
  });
  const vendor = c.partyKind === 'vendor';
  const beforeChange = new Set(c.beforeChangeDocumentIds ?? []);
  const history = vendor
    ? null
    : await getVerificationReviewHistory(session, id, before).catch(() => null);
  const reviewerNames = new Map(
    history?.items.map((entry) => [entry.reviewedBy, entry.reviewerName]),
  );
  // The case names its party (customer or vendor) under its own read; the customer record is a fallback.
  const name =
    c.partyName !== undefined && c.partyName !== null && c.partyName !== ''
      ? c.partyName
      : customerLabel(customer, c.partyId);
  const status = VERIFICATION_STATUS_LABEL[c.status];
  const progress = checklistProgress(c.checklist);
  // What this person may do with this case, decided by the API on the case (its party's owner and the person's
  // scope), not by role defaults. Without flags (an older API) nothing is offered; the API decides every call.
  const can = c.can ?? { review: false, edit: false, attach: false, remove: false };
  const mayReview = can.review;
  const mayEdit = can.edit;
  const editable = mayEdit && (c.status === 'draft' || c.status === 'rejected');
  const mayAttach = editable && can.attach;
  const mayRemove = editable && can.remove;
  const legacy = !vendor && c.reviewPolicy === 'case_review_v0';
  const actions = legacy ? null : c.status === 'draft' && mayEdit ? (
    <SubmitForm
      key={c.id}
      caseId={c.id}
      idempotencyKey={randomUUID()}
      version={c.version}
      missing={missingForSubmit(c)}
      reloadHref={path}
    />
  ) : c.status === 'submitted' && mayReview && !c.reviewBlockedReason ? (
    <ReviewForm
      key={c.id}
      caseId={c.id}
      version={c.version}
      idempotencyKey={randomUUID()}
      canReject={canReject(c)}
      approvalProblems={approvalProblems(c, approvalFiles)}
      reloadHref={path}
    />
  ) : null;
  return (
    <Page>
      <div className={styles.caseHeader}>
        <Breadcrumb items={[{ label: 'Verification', href: '/verification' }, { label: name }]} />
        <PageHeader
          title={name}
          actions={actions}
          status={<Badge tone={status.tone}>{status.text}</Badge>}
          description={
            customer !== undefined
              ? `${customer.number}${customer.panVatNo !== null ? ` · PAN/VAT ${customer.panVatNo}` : ''}`
              : c.partyKind === 'vendor'
                ? 'Vendor'
                : (c.partyNumber ?? 'The customer record could not be read.')
          }
        />
      </div>

      <div className={styles.caseNotices}>
        {c.identityReset ? (
          <Alert tone="warning" role="region" aria-label="Details changed">
            Details changed on <time dateTime={c.identityReset.at}>{when(c.identityReset.at)}</time>{' '}
            by <span>{c.identityReset.byName ?? 'a staff member'}</span>; upload the documents
            again.
          </Alert>
        ) : null}
        {legacy ? (
          <Alert tone="info">
            {c.status === 'approved'
              ? 'Approved before document review.'
              : 'This case needs an update before review.'}
          </Alert>
        ) : c.status === 'submitted' && c.checklist.some((item) => item.status === 'rejected') ? (
          <Alert tone="warning">
            {mayReview
              ? 'Reject the case so Sales can replace the rejected documents.'
              : 'You can replace rejected documents once the case is returned.'}
          </Alert>
        ) : c.status === 'submitted' && c.reviewBlockedReason ? (
          <Alert tone="info">{c.reviewBlockedReason}</Alert>
        ) : c.status === 'submitted' ? (
          <Alert tone="info">
            {mayReview
              ? 'Review the documents before recording a decision.'
              : 'The documents are locked while this case is under review. The decision will appear here.'}
          </Alert>
        ) : c.status === 'rejected' && (mayAttach || mayRemove) ? (
          <p className={styles.note}>Update the documents to reopen this case as a draft.</p>
        ) : null}

        {!legacy && c.status === 'submitted' && c.reviewerNames?.length ? (
          <p className={styles.note}>Can review: {c.reviewerNames.join(', ')}.</p>
        ) : null}

        {c.status === 'approved' || c.status === 'rejected' ? (
          <Alert
            tone={c.status === 'approved' ? 'success' : 'warning'}
            role="region"
            aria-label="Decision"
            title={
              c.status === 'approved'
                ? vendor
                  ? 'This vendor is verified.'
                  : 'This customer is verified.'
                : 'This case was rejected.'
            }
          >
            {c.decidedAt !== null ? (
              <>
                Decided <time dateTime={c.decidedAt}>{when(c.decidedAt)}</time>
                {c.reviewedBy !== null ? (
                  <>
                    {' '}
                    by <span>{reviewerNames.get(c.reviewedBy) || 'a staff member'}</span>
                  </>
                ) : null}
                .
              </>
            ) : null}
            {c.decisionNote !== null ? <p className={styles.comment}>{c.decisionNote}</p> : null}
          </Alert>
        ) : null}
      </div>

      <Panel
        title="Documents"
        className={styles.documents}
        description={progress.required === 0 ? 'No required documents.' : undefined}
        actions={
          progress.required > 0 ? (
            <div className={styles.documentProgress}>
              <span>
                {progress.accepted} of {progress.required} required accepted
              </span>
              <progress aria-hidden="true" value={progress.accepted} max={progress.required} />
            </div>
          ) : null
        }
      >
        <p className={styles.tableHint}>Scroll sideways to see all columns.</p>
        <Table
          caption="Verification documents"
          minWidth={790}
          className={styles.documentTable ?? ''}
        >
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Required</Th>
              <Th>Status</Th>
              <Th>File</Th>
              <Th>Expires</Th>
              {!vendor && <Th>Review</Th>}
            </tr>
          </thead>
          <tbody>
            {c.checklist.map((item) => {
              const status = ITEM_STATUS[item.status];
              const label = CHECKLIST_LABEL[item.key];
              return (
                <tr key={`${c.id}/${item.key}`}>
                  <Th scope="row" className={styles.rowHeader}>
                    <span className={styles.itemName}>{label}</span>
                  </Th>
                  <Td nowrap className={styles.required}>
                    {item.required ? <CheckMark /> : null}
                    <span className="sr-only">{item.required ? 'Required' : 'Optional'}</span>
                  </Td>
                  <Td nowrap>
                    <Badge tone={status.tone}>{status.text}</Badge>
                  </Td>
                  <Td>
                    <ChecklistFile
                      caseId={c.id}
                      version={c.version}
                      caseStatus={c.status}
                      item={item}
                      label={label}
                      file={item.documentId === null ? null : (files.get(item.documentId) ?? null)}
                      mayAttach={mayAttach}
                      mayRemove={mayRemove}
                      allowedMime={[...ALLOWED_MIME]}
                      maxBytes={MAX_UPLOAD_BYTES}
                    />
                  </Td>
                  <Td nowrap>
                    {item.expiresOn !== null ? (
                      <time dateTime={item.expiresOn}>{when(item.expiresOn, 'date')}</time>
                    ) : (
                      <span className={styles.quiet}>No expiry</span>
                    )}
                  </Td>
                  {!vendor && (
                    <Td className={styles.reviewCell}>
                      {item.review ? (
                        <>
                          <span className={styles.note}>
                            {when(item.review.reviewedAt)} ·{' '}
                            {reviewerNames.get(item.review.reviewedBy) || 'a staff member'}
                          </span>
                          {item.review.comment && (
                            <p className={styles.comment}>{item.review.comment}</p>
                          )}
                        </>
                      ) : null}
                      {!legacy &&
                      mayReview &&
                      !c.reviewBlockedReason &&
                      c.status === 'submitted' &&
                      item.status === 'provided' ? (
                        <ItemReview
                          key={`${item.key}/${c.version}`}
                          caseId={c.id}
                          itemKey={item.key}
                          label={label}
                          version={c.version}
                          canApprove={
                            !!item.documentId &&
                            files.get(item.documentId)?.status === 'clean' &&
                            (!item.expiresOn || item.expiresOn > todayInKathmandu())
                          }
                        />
                      ) : null}
                    </Td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Panel>
      <div className={styles.supporting}>
        {!vendor && (
          <Panel title="Review history">
            {history !== null ? (
              <>
                {history.items.length > 0 ? (
                  <ol className={styles.history}>
                    {history.items.map((entry) => (
                      <li key={entry.id} className={styles.historyEntry}>
                        <Icon
                          name={entry.decision === 'approve' ? 'check-circle' : 'x-circle'}
                          size={16}
                          className={
                            entry.decision === 'approve' ? styles.approved : styles.rejected
                          }
                        />
                        <div className={styles.historyText}>
                          <p className={styles.itemName}>
                            {entry.itemKey ? CHECKLIST_LABEL[entry.itemKey] : 'Case'} ·{' '}
                            {entry.decision === 'approve' ? 'Approved' : 'Rejected'}
                          </p>
                          <p className={styles.note}>
                            <time dateTime={entry.reviewedAt}>{when(entry.reviewedAt)}</time>
                            {' · '}
                            {entry.reviewerName || 'a staff member'}
                          </p>
                          {entry.comment ? <p className={styles.comment}>{entry.comment}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className={styles.note}>No decisions recorded.</p>
                )}
                {history.nextCursor ? (
                  <Link
                    className={styles.caseLink}
                    href={`${path}?before=${encodeURIComponent(history.nextCursor)}`}
                  >
                    Earlier decisions
                  </Link>
                ) : null}
              </>
            ) : (
              <Alert tone="error" actions={<Link href={path}>Reload this case</Link>}>
                Review history could not be loaded.
              </Alert>
            )}
          </Panel>
        )}
        {c.looseEvidence?.length ? (
          <Panel
            as="aside"
            title={vendor ? 'Earlier files' : 'Other case attachments'}
            description={
              vendor
                ? 'Kept as history. Upload the documents again.'
                : 'All active attachments must pass scanning.'
            }
          >
            <ul className={styles.attachments}>
              {c.looseEvidence.map((file) => {
                const scan = scanLabel(file.status);
                return (
                  <li key={file.documentId} className={styles.attachment}>
                    <Icon name="file-text" size={18} />
                    <div>
                      <p className={styles.itemName}>{file.filename}</p>
                      {beforeChange.has(file.documentId) ? (
                        <Badge tone="neutral">Before the change</Badge>
                      ) : null}
                      <Badge
                        tone={
                          scan.tone === 'good'
                            ? 'success'
                            : scan.tone === 'wait'
                              ? 'warning'
                              : 'error'
                        }
                      >
                        {scan.text}
                      </Badge>
                    </div>
                    {mayAttach && !vendor && !beforeChange.has(file.documentId) ? (
                      <RemoveLoose
                        caseId={c.id}
                        documentId={file.documentId}
                        filename={file.filename}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}
