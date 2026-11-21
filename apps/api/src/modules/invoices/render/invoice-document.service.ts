// InvoiceDocumentService: a staff member downloads the rendered PDF of an issued invoice (P3 unit U11), and asks for a
// fresh render when it could not be prepared (round 4, R4c2: TR-Q4 and F1-Q13). Serves the NFRs:
// - "a file is served only after a clean scan": the link comes from DocumentsService.issueLinkForOwner, which refuses
//   unless the newest upload of the document is `clean`;
// - "authorization is deny-by-default" and "one legal entity at a time": the invoice is read under the same
//   scopeWhereFor('invoice.read') rule as the drafting reads, so another entity's invoice is a 404 rather than a 403;
// - "a draft is not a document": only an issued invoice has a PDF.
// Once the caller may read the issued invoice, the refusals are told apart so the screen shows one "Preparing PDF"
// state and never a "not found" for a PDF that is on its way (TR-Q4): no PDF yet, or a file still being stored or
// scanned, is a 409 `invoice_pdf_not_ready` (the render sweeper is still trying, see render-retry.ts); a render that
// was given up is a 424 `invoice_pdf_failed` (staff may Retry); a file that was refused by the virus scan is a 404
// `invoice_pdf_scan_refused`, and one that went away between the read and the link a 404 `invoice_pdf_unavailable`.
// The state comes from generatedPdfState (render-state.ts), which the portal status reads too. A draft, a random id
// or another entity's invoice stays one plain 404 `not_found`.
// Staff only: a portal caller reads through the portal API (U13).
import type { SignedLinkDto } from '@bos/contracts';
import { documents, documentVersions, invoices, scoped } from '@bos/db';
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { scopeWhereFor } from '../../../platform/authz/authz.service';
import { DB, type Db } from '../../../platform/db/db.module';
import { READ_ONLY, withTx } from '../../../platform/db/tx';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { INVOICE_OWNER_TYPE } from '../invoice-owner.policy';
import { assertStaff, InvoiceCaller } from '../invoice-support';
import { InvoiceRenderNudge } from './invoice-render.nudge';
import { RENDERABLE_INVOICE_KINDS } from './invoice-view';
import { renderGivenUp, retryGivenUpRender, type RenderFailureOwner } from './render-failures';
import { generatedPdfState } from './render-state';

/** What the retry answers: the invoice is back in the render queue. */
export interface InvoicePdfRetryDto {
  state: 'queued';
}

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Invoice document not found' });
const notReady = () =>
  new ConflictException({
    code: 'invoice_pdf_not_ready',
    message: 'The PDF of this invoice is still being prepared',
  });
/** 424 Failed Dependency: the render (the dependency of the download) was given up. */
const renderFailed = () =>
  new HttpException({ code: 'invoice_pdf_failed', message: 'The PDF could not be prepared' }, 424);
const unavailable = () =>
  new NotFoundException({ code: 'invoice_pdf_unavailable', message: 'This PDF is not available' });
/** The virus scan refused the stored file (infected, or the scan failed): it is never served. */
const scanRefused = () =>
  new NotFoundException({
    code: 'invoice_pdf_scan_refused',
    message: 'The virus scan refused this PDF, so it cannot be served',
  });
const retryNotNeeded = () =>
  new ConflictException({
    code: 'invoice_pdf_retry_not_needed',
    message: 'The PDF of this invoice has not failed, so there is nothing to retry',
  });

/** What the link decided inside the read transaction. */
type LinkState =
  | { kind: 'hidden' }
  | { kind: 'clean'; documentId: string }
  | { kind: 'preparing' }
  | { kind: 'failed' }
  | { kind: 'scan_refused' };

const ownerOf = (scope: { tenantId: string; organizationId: string }, invoiceId: string) =>
  ({
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    ownerType: INVOICE_OWNER_TYPE,
    ownerId: invoiceId,
  }) satisfies RenderFailureOwner;

@Injectable()
export class InvoiceDocumentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly caller: InvoiceCaller,
    private readonly audit: AuditService,
    // Optional so a hand-built service (tests) keeps its argument list; without it a Retry waits for the sweep.
    @Optional() private readonly renderNudge?: InvoiceRenderNudge,
  ) {}

  /**
   * A signed link to the clean PDF of one issued invoice: the original (the oldest live document that scanned clean),
   * never a reprint while the original is there. 403 for a portal caller; 404 `not_found` for a draft, a random id or
   * an invoice outside the caller's entity and read scope; then 409 `invoice_pdf_not_ready` while the PDF is being
   * prepared, 424 `invoice_pdf_failed` once its render was given up, 404 `invoice_pdf_scan_refused` when the virus
   * scan refused it, 404 `invoice_pdf_unavailable` when it went away before the link was issued.
   */
  async link(invoiceId: string): Promise<SignedLinkDto> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    const visible = scopeWhereFor(principal, invoices, 'invoice.read');
    const state = await withTx(
      this.db,
      scope,
      actor,
      async (tx): Promise<LinkState> => {
        const [invoice] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              visible,
              eq(invoices.id, invoiceId),
              eq(invoices.status, 'issued'),
              // The sweeper's own filter: "preparing" (409) only for an invoice it will render.
              inArray(invoices.kind, [...RENDERABLE_INVOICE_KINDS]),
            ),
          )
          .limit(1);
        if (invoice === undefined) return { kind: 'hidden' };
        // Every upload of every live document of the invoice: oldest document first, newest upload first within it.
        const uploads = await tx
          .select({ documentId: documents.id, status: documentVersions.status })
          .from(documents)
          .innerJoin(
            documentVersions,
            and(
              eq(documentVersions.tenantId, documents.tenantId),
              eq(documentVersions.documentId, documents.id),
            ),
          )
          .where(
            scoped(scope).where(
              documents,
              and(
                eq(documents.ownerType, INVOICE_OWNER_TYPE),
                eq(documents.ownerId, invoiceId),
                isNull(documents.removedAt),
              ),
            ),
          )
          .orderBy(asc(documents.createdAt), asc(documents.id), desc(documentVersions.version));
        // The original is the oldest document with a clean upload (issueLinkForOwner then checks its newest upload).
        return generatedPdfState(uploads, await renderGivenUp(tx, ownerOf(scope, invoiceId)));
      },
      READ_ONLY,
    );
    if (state.kind === 'hidden') throw notFound();
    if (state.kind === 'preparing') throw notReady();
    if (state.kind === 'failed') throw renderFailed();
    if (state.kind === 'scan_refused') throw scanRefused();
    try {
      return await this.documents.issueLinkForOwner(
        scope,
        { ownerType: INVOICE_OWNER_TYPE, ownerId: invoiceId },
        state.documentId,
      );
    } catch (error) {
      // Clean a moment ago, refused now (removed meanwhile, or a newer upload): the file is not available.
      if (error instanceof NotFoundException) throw unavailable();
      throw error;
    }
  }

  /**
   * Puts the PDF of an invoice whose render was given up back in the render queue: 202 `{ state: 'queued' }`. 403 for
   * a portal caller; 404 for an invoice that is not issued, not printable, or outside the caller's `invoice.issue`
   * scope (the permission of the action that triggers the render); 409 `invoice_pdf_retry_not_needed` when the render
   * was not given up (never failed, still being tried, or retried already). The state change and its audit row are one
   * transaction under the caller's scope and actor.
   */
  async retry(invoiceId: string): Promise<InvoicePdfRetryDto> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    await withTx(this.db, scope, actor, async (tx) => {
      const [invoice] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            scopeWhereFor(principal, invoices, 'invoice.issue'),
            eq(invoices.id, invoiceId),
            eq(invoices.status, 'issued'),
            inArray(invoices.kind, [...RENDERABLE_INVOICE_KINDS]),
          ),
        )
        .limit(1);
      if (invoice === undefined) throw notFound();
      const cleared = await retryGivenUpRender(tx, ownerOf(scope, invoiceId));
      if (cleared === null) throw retryNotNeeded();
      await this.audit.record(tx, {
        action: 'invoice.pdf_retry_requested',
        entityType: 'invoices',
        entityId: invoiceId,
        before: { attempts: cleared.attempts, failureKind: cleared.kind },
        after: { state: 'queued' },
      });
    });
    // After the commit: render now instead of on the next one-minute sweep. Never throws.
    await this.renderNudge?.nudge(scope, invoiceId);
    return { state: 'queued' };
  }
}
