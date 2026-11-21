// PurchaseOrderDocumentService: a staff member downloads the rendered PDF of one issued version of a purchase order
// (P4 unit P3b), and asks for a fresh render when it could not be prepared (round 4, R4c2: TR-Q4 and F1-Q13). Serves
// the NFRs:
// - "a file is served only after a clean scan": the link comes from DocumentsService.issueLinkForOwner, which refuses
//   unless the newest upload of the document is `clean`;
// - "one legal entity at a time": the version is read scoped to the acting entity, so another entity's PO is a 404
//   rather than a 403.
// A version the caller cannot see (another entity, a random id, a version that does not exist) is one plain 404
// `not_found`. Once the version is there, the refusals are told apart so the screen shows one "Preparing PDF" state
// and never a "not found" for a PDF that is on its way (TR-Q4): no PDF yet, or a file still being stored, is a 409
// `purchase_order_pdf_not_ready` (the render sweeper is still trying, see render-retry.ts); a render that was given up
// is a 424 `purchase_order_pdf_failed` (staff may Retry); a file the virus scan refused is a 404
// `purchase_order_pdf_scan_refused`, and one that went away between the read and the link a 404
// `purchase_order_pdf_unavailable`.
// Staff only: a vendor reads through the vendor portal API, which asks the same documents module with its own checks.
// The download is open to whoever may read the order (F1-Q52, po-read-access.ts: issuers, and read-only the bill and
// receipt roles on the orders their grant reaches; an order out of reach is the same plain 404). Retry stays with
// procurement.po.issue.
import type { SignedLinkDto } from '@bos/contracts';
import {
  documents,
  documentVersions,
  purchaseOrders,
  purchaseOrderVersions,
  purchaseRequests,
  scoped,
} from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { AuditService } from '../../../../platform/audit/audit.service';
import { DB, type Db, type DbTransaction } from '../../../../platform/db/db.module';
import { READ_ONLY, withTx, type TxScope } from '../../../../platform/db/tx';
import { DocumentsService } from '../../../../platform/documents/documents.service';
import {
  renderGivenUp,
  retryGivenUpRender,
  type RenderFailureOwner,
} from '../../../invoices/render/render-failures';
import { generatedPdfState } from '../../../invoices/render/render-state';
import { assertHoldsPoRead, mayReadPo, requestFactsColumns, requestOf } from '../po-read-access';
import { PO_AUDIT_ENTITY } from '../purchase-order.rules';
import { PurchaseOrdersCaller } from '../purchase-orders.caller';
import { PurchaseOrderRenderNudge } from './purchase-order-render.nudge';
import { PO_VERSION_OWNER_TYPE } from './purchase-order-version-owner.policy';

/** What the retry answers: the version is back in the render queue. */
export interface PurchaseOrderPdfRetryDto {
  state: 'queued';
}

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Purchase order document not found' });
const notReady = () =>
  new ConflictException({
    code: 'purchase_order_pdf_not_ready',
    message: 'The PDF of this purchase order is still being prepared',
  });
/** 424 Failed Dependency: the render (the dependency of the download) was given up. */
const renderFailed = () =>
  new HttpException(
    { code: 'purchase_order_pdf_failed', message: 'The PDF could not be prepared' },
    424,
  );
const unavailable = () =>
  new NotFoundException({
    code: 'purchase_order_pdf_unavailable',
    message: 'This PDF is not available',
  });
/** The virus scan refused the stored file (infected, or the scan failed): it is never served. */
const scanRefused = () =>
  new NotFoundException({
    code: 'purchase_order_pdf_scan_refused',
    message: 'The virus scan refused this PDF, so it cannot be served',
  });
const retryNotNeeded = () =>
  new ConflictException({
    code: 'purchase_order_pdf_retry_not_needed',
    message: 'The PDF of this version has not failed, so there is nothing to retry',
  });

/** The largest value of an integer column; a version number above it cannot exist, and must not reach the query. */
const MAX_VERSION = 2_147_483_647;

/** What the link decided inside the read transaction. */
type LinkState =
  | { kind: 'hidden' }
  | { kind: 'clean'; versionId: string; documentId: string }
  | { kind: 'preparing' }
  | { kind: 'failed' }
  | { kind: 'scan_refused' };

const ownerOf = (scope: TxScope, versionId: string): RenderFailureOwner => ({
  tenantId: scope.tenantId,
  organizationId: scope.organizationId,
  ownerType: PO_VERSION_OWNER_TYPE,
  ownerId: versionId,
});

@Injectable()
export class PurchaseOrderDocumentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly caller: PurchaseOrdersCaller,
    private readonly audit: AuditService,
    // Optional so a hand-built service (tests) keeps its argument list; without it a Retry waits for the sweep.
    @Optional() private readonly renderNudge?: PurchaseOrderRenderNudge,
  ) {}

  /**
   * A signed link to the clean PDF of version `version` of one purchase order: the oldest live document that scanned
   * clean. 403 for a portal caller; 404 `not_found` for a version outside the caller's entity or one that does not
   * exist; then 409 `purchase_order_pdf_not_ready` while the PDF is being prepared, 424 `purchase_order_pdf_failed`
   * once its render was given up, 404 `purchase_order_pdf_scan_refused` when the virus scan refused it, 404
   * `purchase_order_pdf_unavailable` when it went away before the link was issued.
   */
  async link(purchaseOrderId: string, version: number): Promise<SignedLinkDto> {
    const { scope, actor, principal } = this.staffCaller();
    assertHoldsPoRead(principal);
    if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) throw notFound();
    const state = await withTx(
      this.db,
      scope,
      actor,
      async (tx): Promise<LinkState> => {
        const [po] = await tx
          .select({ request: requestFactsColumns })
          .from(purchaseOrders)
          .innerJoin(purchaseRequests, requestOf(purchaseOrders))
          .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, purchaseOrderId)));
        if (po === undefined || !mayReadPo(principal, po.request)) return { kind: 'hidden' };
        const versionId = await this.versionId(tx, scope, purchaseOrderId, version);
        if (versionId === undefined) return { kind: 'hidden' };
        // Every upload of every live document of the version: oldest document first, newest upload first within it.
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
                eq(documents.ownerType, PO_VERSION_OWNER_TYPE),
                eq(documents.ownerId, versionId),
                isNull(documents.removedAt),
              ),
            ),
          )
          .orderBy(asc(documents.createdAt), asc(documents.id), desc(documentVersions.version));
        const pdf = generatedPdfState(uploads, await renderGivenUp(tx, ownerOf(scope, versionId)));
        if (pdf.kind === 'clean') return { kind: 'clean', versionId, documentId: pdf.documentId };
        return pdf;
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
        { ownerType: PO_VERSION_OWNER_TYPE, ownerId: state.versionId },
        state.documentId,
      );
    } catch (error) {
      // Clean a moment ago, refused now (removed meanwhile, or a newer upload): the file is not available.
      if (error instanceof NotFoundException) throw unavailable();
      throw error;
    }
  }

  /**
   * Puts the PDF of a version whose render was given up back in the render queue: 202 `{ state: 'queued' }`. The route
   * needs procurement.po.issue, the permission of the action that triggers the render. 403 for a portal caller; 404 for
   * a version outside the caller's entity; 409 `purchase_order_pdf_retry_not_needed` when the render was not given up
   * (never failed, still being tried, or retried already). The state change and its audit row are one transaction
   * under the caller's scope and actor.
   */
  async retry(purchaseOrderId: string, version: number): Promise<PurchaseOrderPdfRetryDto> {
    const { scope, actor } = this.staffCaller();
    if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) throw notFound();
    await withTx(this.db, scope, actor, async (tx) => {
      const versionId = await this.versionId(tx, scope, purchaseOrderId, version);
      if (versionId === undefined) throw notFound();
      const cleared = await retryGivenUpRender(tx, ownerOf(scope, versionId));
      if (cleared === null) throw retryNotNeeded();
      await this.audit.record(tx, {
        action: 'purchase_order.pdf_retry_requested',
        entityType: PO_AUDIT_ENTITY,
        entityId: purchaseOrderId,
        before: { versionId, attempts: cleared.attempts, failureKind: cleared.kind },
        after: { versionId, state: 'queued' },
      });
    });
    // After the commit: render now instead of on the next one-minute sweep. Never throws.
    await this.renderNudge?.nudge(scope, purchaseOrderId, version);
    return { state: 'queued' };
  }

  private staffCaller() {
    const current = this.caller.current();
    if (current.principal.orgKind !== 'staff') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    return current;
  }

  /** The id of version `version` of the purchase order, in the caller's entity; undefined when there is none. */
  private async versionId(
    tx: DbTransaction,
    scope: TxScope,
    purchaseOrderId: string,
    version: number,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: purchaseOrderVersions.id })
      .from(purchaseOrderVersions)
      .where(
        scoped(scope).where(
          purchaseOrderVersions,
          and(
            eq(purchaseOrderVersions.purchaseOrderId, purchaseOrderId),
            eq(purchaseOrderVersions.version, version),
          ),
        ),
      )
      .limit(1);
    return row?.id;
  }
}
