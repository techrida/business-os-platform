import { randomUUID } from 'node:crypto';

import {
  ALLOWED_MIME,
  MAX_UPLOAD_BYTES,
  type CustomerDto,
  type VerificationCaseDto,
} from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getDocument } from '@/components/p2/crm/verification-api';
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
import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { CheckMark, ChecklistFile } from './checklist-file';
import { ReviewForm } from './review-form';
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
  return required
    .filter((item) => item.documentId === null || !['provided', 'accepted'].includes(item.status))
    .map((item) => CHECKLIST_LABEL[item.key]);
}

export default async function VerificationCasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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

  // The name is a courtesy: a failed lookup shows the short id and the case still works.
  let customer: CustomerDto | undefined;
  try {
    customer = await getCustomer(session, c.partyId);
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
    approvalFiles.set(
      documentId,
      r.status === 'fulfilled' ? approvalFile(r.value.versions) : 'unavailable',
    );
    files.set(documentId, r.status === 'fulfilled' ? fileOf(r.value) : null);
  });
  const name = customerLabel(customer, c.partyId);
  const status = VERIFICATION_STATUS_LABEL[c.status];
  const progress = checklistProgress(c.checklist);
  const mayReview = hasPermission(session.roles, 'verification.review');
  const mayEdit = hasPermission(session.roles, 'customer.write');
  const editable = mayEdit && (c.status === 'draft' || c.status === 'rejected');
  const mayAttach = editable && hasPermission(session.roles, 'documents.upload');
  const mayRemove = editable && hasPermission(session.roles, 'verification.read');
  const actions =
    c.status === 'draft' && mayEdit ? (
      <SubmitForm
        key={c.id}
        caseId={c.id}
        idempotencyKey={randomUUID()}
        missing={missingForSubmit(c)}
        reloadHref={path}
      />
    ) : c.status === 'submitted' && mayReview ? (
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
      <Breadcrumb items={[{ label: 'Verification', href: '/verification' }, { label: name }]} />
      <PageHeader
        title={name}
        actions={actions}
        status={<Badge tone={status.tone}>{status.text}</Badge>}
        description={
          customer !== undefined
            ? `${customer.number}${customer.panVatNo !== null ? ` · PAN/VAT ${customer.panVatNo}` : ''}`
            : 'The customer record could not be read.'
        }
      />

      {c.status === 'submitted' ? (
        <p className={styles.note}>
          {mayReview
            ? 'Review the documents before recording a decision.'
            : 'The documents are locked while this case is under review. The decision will appear here.'}
        </p>
      ) : c.status === 'rejected' && (mayAttach || mayRemove) ? (
        <p className={styles.note}>Update the documents to reopen this case as a draft.</p>
      ) : null}

      {c.status === 'approved' || c.status === 'rejected' ? (
        <Alert
          tone={c.status === 'approved' ? 'success' : 'warning'}
          role="region"
          aria-label="Decision"
          title={c.status === 'approved' ? 'This customer is verified.' : 'This case was rejected.'}
        >
          {c.decidedAt !== null ? (
            <>
              Decided <time dateTime={c.decidedAt}>{when(c.decidedAt)}</time>
              {c.reviewedBy !== null ? (
                <>
                  {' '}
                  by <span>a staff member</span>
                </>
              ) : null}
              .
            </>
          ) : null}
          {c.decisionNote !== null ? <p className={styles.comment}>{c.decisionNote}</p> : null}
        </Alert>
      ) : null}

      <Panel
        title="Documents"
        description={
          progress.required === 0
            ? 'This case has no required document yet.'
            : `${progress.accepted} of ${progress.required} required documents accepted.`
        }
      >
        <Table caption="Verification documents" minWidth={660}>
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Required</Th>
              <Th>Status</Th>
              <Th>File</Th>
              <Th>Expires</Th>
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
                  <Td nowrap>
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
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Panel>
    </Page>
  );
}
