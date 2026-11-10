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
import { downloadHref, fileOf, type FileView } from '@/components/p2/crm/verification-file';
import { getCustomer, getVerificationCase } from '@/components/p2/customers/api';
import {
  canApprove,
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
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import { formatBytes, scanLabel } from '@/lib/kernel-ui';

import { AttachForm, type AttachOption } from './attach-form';
import { ReviewForm } from './review-form';
import { SubmitForm } from '../submit-form';
import styles from '../verification.module.css';

export const metadata: Metadata = { title: 'Verification case · Business OS' };
export const dynamic = 'force-dynamic';

const SCAN_TONE = { good: 'success', wait: 'warning', bad: 'error' } as const;

/** One attached file: its name, scan result and, once the scan passed, a link that opens it. */
function AttachedFile({
  documentId: _documentId,
  file,
}: {
  documentId: string;
  file: FileView | null | 'unavailable';
}) {
  const ref = <span className={styles.ref}>Attached document</span>;
  if (file === null || file === 'unavailable') {
    return (
      <div className={styles.file}>
        {ref}
        <span className={styles.quiet}>
          {file === null ? 'No readable version.' : 'The file details could not be read.'}
        </span>
      </div>
    );
  }
  const scan = scanLabel(file.status);
  return (
    <div className={styles.file}>
      <span className={styles.itemName}>{file.filename}</span>
      <span className={styles.quiet}>{formatBytes(file.sizeBytes)}</span>
      <Badge tone={SCAN_TONE[scan.tone]}>{scan.text}</Badge>
      {file.status === 'clean' ? (
        <LinkButton
          variant="secondary"
          size="small"
          href={downloadHref(file)}
          aria-label={`Open ${file.filename}`}
        >
          Open file
        </LinkButton>
      ) : null}
    </div>
  );
}

function approveBlockedReason(c: VerificationCaseDto): string | null {
  if (canApprove(c)) return null;
  if (c.status !== 'submitted') return null;
  const p = checklistProgress(c.checklist);
  if (p.required === 0) return 'Approve opens when the case has a required document.';
  return `Approve opens when every required document is accepted (${p.accepted} of ${p.required} so far). You can still reject.`;
}

/** Why Submit is closed: the required items that still have no file. Null when it may go. */
function submitBlockedReason(c: VerificationCaseDto): string | null {
  const missing = c.checklist.filter((i) => i.required && i.documentId === null);
  if (missing.length === 0 && c.checklist.some((i) => i.required)) return null;
  if (missing.length === 0) return 'Submit opens when the case has a required document.';
  return `Submit opens when every required document has a file. Still missing: ${missing
    .map((i) => CHECKLIST_LABEL[i.key])
    .join(', ')}.`;
}

/** The checklist as options for the attach form: name, whether it is required, where it stands. */
function attachOptions(c: VerificationCaseDto): { items: AttachOption[]; defaultKey: string } {
  const items = c.checklist.map((i) => ({
    key: i.key,
    text: `${CHECKLIST_LABEL[i.key]} · ${i.required ? 'Required' : 'Optional'} · ${CHECKLIST_STATUS[i.status].text}`,
  }));
  const open = c.checklist.filter((i) => i.documentId === null);
  const first = open.find((i) => i.required) ?? open[0];
  return { items, defaultKey: first?.key ?? '' };
}

export default async function VerificationCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ submitted?: string | string[] }>;
}) {
  const { id } = await params;
  const { submitted } = await searchParams;
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

  // The name is a courtesy: a failed lookup shows an unavailable-name label and the case still works.
  let customer: CustomerDto | undefined;
  try {
    customer = await getCustomer(session, c.partyId);
  } catch {
    customer = undefined;
  }
  // Each attached file is looked up on its own: one refusal (the reviewer may not read it) or one
  // failure leaves the other rows and the decision form working. No signed link is issued here;
  // it is issued by the download route when the link is clicked.
  const documentIds = c.checklist.flatMap((i) => (i.documentId !== null ? [i.documentId] : []));
  const lookups = await Promise.allSettled(documentIds.map((d) => getDocument(session, d)));
  const files = new Map<string, FileView | null | 'unavailable'>();
  lookups.forEach((r, i) => {
    const documentId = documentIds[i];
    if (documentId === undefined) return;
    files.set(documentId, r.status === 'fulfilled' ? fileOf(r.value) : 'unavailable');
  });
  const name = customerLabel(customer, c.partyId);
  const status = VERIFICATION_STATUS_LABEL[c.status];
  const progress = checklistProgress(c.checklist);
  const mayReview = hasPermission(session.roles, 'verification.review');
  const mayEdit = hasPermission(session.roles, 'customer.write');
  // Only a draft or a rejected case can take documents; the API checks both permissions again.
  const mayAttach =
    mayEdit &&
    c.checklist.length > 0 &&
    hasPermission(session.roles, 'documents.upload') &&
    (c.status === 'draft' || c.status === 'rejected');
  const attach = attachOptions(c);

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Verification', href: '/verification' }, { label: name }]} />
      <PageHeader
        title={name}
        status={<Badge tone={status.tone}>{status.text}</Badge>}
        description={
          customer !== undefined
            ? `${customer.number}${customer.panVatNo !== null ? ` · PAN/VAT ${customer.panVatNo}` : ''}`
            : 'The customer record could not be read.'
        }
      />

      {submitted !== undefined && c.status === 'submitted' ? (
        <Alert tone="success" role="status" title="Submitted for review.">
          The reviewer can now see the documents. You will see the decision here.
        </Alert>
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
                  by <span>Name unavailable</span>
                </>
              ) : null}
              .
            </>
          ) : null}
          {c.decisionNote !== null ? <p className={styles.comment}>{c.decisionNote}</p> : null}
        </Alert>
      ) : null}

      <div className={styles.columns}>
        <div className={styles.main}>
          <Panel
            title="Documents"
            description={
              progress.required === 0
                ? 'This case has no required document yet.'
                : `${progress.accepted} of ${progress.required} required documents accepted.`
            }
          >
            <Table caption="Verification documents" minWidth={560}>
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
                  const s = CHECKLIST_STATUS[item.status];
                  return (
                    <tr key={item.key}>
                      <Td>
                        <span className={styles.itemName}>{CHECKLIST_LABEL[item.key]}</span>
                      </Td>
                      <Td nowrap>{item.required ? 'Required' : 'Optional'}</Td>
                      <Td nowrap>
                        <Badge tone={s.tone}>{s.text}</Badge>
                      </Td>
                      <Td>
                        {item.documentId !== null ? (
                          <AttachedFile
                            documentId={item.documentId}
                            file={files.get(item.documentId) ?? 'unavailable'}
                          />
                        ) : (
                          <span className={styles.quiet}>Nothing attached</span>
                        )}
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

          {mayAttach ? (
            <Panel
              title="Attach a document"
              description="Upload a file and put it on one checklist item. Repeat for each document."
            >
              <AttachForm
                caseId={c.id}
                version={c.version}
                reopens={c.status === 'rejected'}
                items={attach.items}
                defaultKey={attach.defaultKey}
                // One key per render of this page; the form takes the next one from each answer.
                idempotencyKey={randomUUID()}
                maxBytes={MAX_UPLOAD_BYTES}
                allowedMime={[...ALLOWED_MIME]}
              />
            </Panel>
          ) : null}
        </div>

        <Panel
          as="aside"
          title={c.status === 'draft' && mayEdit ? 'Submit for review' : 'Your decision'}
          className={styles.side}
        >
          {c.status === 'draft' && mayEdit ? (
            <SubmitForm
              caseId={c.id}
              // One key per render of this page, like the decision form's.
              idempotencyKey={randomUUID()}
              blockedReason={submitBlockedReason(c)}
              reloadHref={path}
            />
          ) : c.status !== 'submitted' ? (
            <p className={styles.note}>
              {c.status === 'draft'
                ? 'This case has not been submitted for review yet, so there is nothing to decide.'
                : c.status === 'rejected' && mayAttach
                  ? 'This case was rejected. Use Attach a document to reopen it as a draft, then submit it again.'
                  : 'This case has been decided, so there is nothing left to do.'}
            </p>
          ) : !mayReview ? (
            <p className={styles.note}>
              Your roles do not include verification review. You can read this case, but you cannot
              decide it.
            </p>
          ) : (
            <ReviewForm
              caseId={c.id}
              version={c.version}
              // One key per render of this page: a double click or a retry after a network
              // error sends the same key, so the decision is applied once.
              idempotencyKey={randomUUID()}
              canApprove={canApprove(c)}
              canReject={canReject(c)}
              approveBlockedReason={approveBlockedReason(c)}
              reloadHref={path}
            />
          )}
        </Panel>
      </div>
    </Page>
  );
}
