// QuotationDocumentService: a staff member downloads the rendered PDF of a quotation version. Serves the NFRs:
// - "a file is served only after a clean scan": the link comes from DocumentsService.issueLinkForOwner, which
//   refuses unless the newest upload of the document is `clean`. The refusals are told apart so the screen can say
//   what is true: still being prepared (no render yet, a failed render the sweeper will try again, or the file awaits
//   its scan) is a 409 `quotation_pdf_not_ready`; a render that was given up after its last try (render-retry.ts) is
//   a 424 `quotation_pdf_failed` (staff can retry it); a file that was removed or whose upload is infected, rejected or
//   failed its scan is a 404 `quotation_pdf_unavailable`. So a quotation never shows "being prepared" for ever
//   (round 4, R4c2: TR-Q4, F1-Q13);
// - a given-up render is requeued by `retry` (render_state failed -> none and its attempts back to 0, so the render
//   sweeper takes it again with a fresh set of tries), audited;
// - "authorization is deny-by-default" and "one legal entity at a time": the version is read in the caller's entity
//   under the same scopeWhereFor('quotation.read') rule as the drafting reads, so another entity's version, or
//   another owner's under `own` scope, is a 404 rather than a 403 that would confirm it exists;
// - staff only: a version carries internal cost, so a portal caller is refused here (the portal has its own route).
import { quotations, quotationVersions } from '@bos/db';
import type { SignedLinkDto } from '@bos/contracts';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, eq, gte } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { scopeWhereFor } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { READ_ONLY, withTx } from '../../../platform/db/tx';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { DraftingCaller } from '../drafting/drafting.caller';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';
import { QuotationRenderNudge } from '../render/quotation-render.nudge';
import { MAX_RENDER_ATTEMPTS, quotationRenderGivenUp } from '../render/render-retry';

/** What the link needs of a version: the entity it lives in and its rendered document, null when none. */
export interface QuotationDocumentHead {
  tenantId: string;
  organizationId: string;
  renderedDocumentId: string | null;
  /** The render job's state for the version: none, pending, rendered or failed. */
  renderState: QuotationRenderState;
  /** Failed renders since the last success or Retry; `failed` at MAX_RENDER_ATTEMPTS is given up. */
  renderAttempts: number;
  /** The version's status; the render sweeper only renders an approved one. */
  status: QuotationVersionStatus;
}

export type QuotationRenderState = (typeof quotationVersions.$inferSelect)['renderState'];
export type QuotationVersionStatus = (typeof quotationVersions.$inferSelect)['status'];

/** What the retry answers: the version is back in the render queue. */
export interface QuotationPdfRetryDto {
  state: 'queued';
}

const AUDIT_ENTITY = 'quotations';

const versionNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Quotation version not found' });
const notReady = () =>
  new ConflictException({
    code: 'quotation_pdf_not_ready',
    message: 'The PDF of this quotation version is not ready to download',
  });
/** 424 Failed Dependency: the render job (the dependency of the download) failed. */
const renderFailed = () =>
  new HttpException(
    { code: 'quotation_pdf_failed', message: 'The PDF could not be prepared' },
    424,
  );
const unavailable = () =>
  new NotFoundException({
    code: 'quotation_pdf_unavailable',
    message: 'This PDF is not available',
  });
const retryNotNeeded = () =>
  new ConflictException({
    code: 'quotation_pdf_retry_not_needed',
    message: 'The PDF of this quotation version has not failed, so there is nothing to retry',
  });

/** The database read of the download, apart from the service so its unit test needs no Postgres. */
@Injectable()
export class QuotationDocumentStore {
  /**
   * The version, when `p` may read its quotation and the version belongs to it; undefined otherwise. The quotation
   * is read through scopeWhereFor, the SQL twin of can(), so the entity and the `own` scope apply as in the list.
   */
  async head(
    tx: DbTransaction,
    p: Principal,
    quotationId: string,
    versionId: string,
    action: 'quotation.read' | 'quotation.send' = 'quotation.read',
  ): Promise<QuotationDocumentHead | undefined> {
    const [row] = await tx
      .select({
        tenantId: quotationVersions.tenantId,
        organizationId: quotationVersions.organizationId,
        renderedDocumentId: quotationVersions.renderedDocumentId,
        renderState: quotationVersions.renderState,
        renderAttempts: quotationVersions.renderAttempts,
        status: quotationVersions.status,
      })
      .from(quotationVersions)
      .innerJoin(
        quotations,
        and(
          eq(quotations.tenantId, quotationVersions.tenantId),
          eq(quotations.organizationId, quotationVersions.organizationId),
          eq(quotations.id, quotationVersions.quotationId),
        ),
      )
      .where(
        and(
          scopeWhereFor(p, quotations, action),
          eq(quotations.id, quotationId),
          eq(quotationVersions.id, versionId),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Puts a given-up render back in the queue: one conditional UPDATE, render_state failed -> none and render_attempts
   * back to 0, only for a version of status approved whose tries are used up (the sweeper renders no other status, so
   * resetting one would only hide the failure; one with tries left is still being retried). The render sweeper takes
   * a `none` approved version on its next pass. True only for the caller that moved it, so a second click, or a
   * sweeper claim in between, changes nothing.
   */
  async requeueFailed(
    tx: DbTransaction,
    head: Pick<QuotationDocumentHead, 'tenantId' | 'organizationId'>,
    versionId: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await tx
      .update(quotationVersions)
      .set({ renderState: 'none', renderAttempts: 0, updatedAt: now })
      .where(
        and(
          eq(quotationVersions.tenantId, head.tenantId),
          eq(quotationVersions.organizationId, head.organizationId),
          eq(quotationVersions.id, versionId),
          eq(quotationVersions.renderState, 'failed'),
          gte(quotationVersions.renderAttempts, MAX_RENDER_ATTEMPTS),
          eq(quotationVersions.status, 'approved'),
        ),
      )
      .returning({ id: quotationVersions.id });
    return rows.length === 1;
  }
}

@Injectable()
export class QuotationDocumentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly store: QuotationDocumentStore,
    private readonly caller: DraftingCaller,
    private readonly audit: AuditService,
    // Optional so a hand-built service (tests) keeps its argument list; without it a Retry waits for the sweep.
    @Optional() private readonly renderNudge?: QuotationRenderNudge,
  ) {}

  /**
   * A signed link to the rendered PDF of one version. 403 for a portal caller; 404 `not_found` when the version is
   * not in the caller's read scope or not of that quotation; 424 `quotation_pdf_failed` when the render was given up;
   * 409 `quotation_pdf_not_ready` while it is not rendered yet (a failed render with tries left included) or its file
   * awaits the scan; 404
   * `quotation_pdf_unavailable` when the file was removed or its upload is infected, rejected or failed the scan.
   * The link is issued after the read transaction closes, in the version's own entity.
   */
  async link(quotationId: string, versionId: string): Promise<SignedLinkDto> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    const head = await withTx(
      this.db,
      scope,
      actor,
      (tx) => this.store.head(tx, principal, quotationId, versionId),
      READ_ONLY,
    );
    if (head === undefined) throw versionNotFound();
    if (quotationRenderGivenUp(head)) throw renderFailed();
    const documentId = head.renderedDocumentId;
    if (head.renderState !== 'rendered' || documentId === null) {
      throw notReady();
    }
    const entity = { tenantId: head.tenantId, organizationId: head.organizationId };
    const owner = { ownerType: QUOTATION_OWNER_TYPE, ownerId: versionId };

    // issueLinkForOwner answers one 404 for every refusal, so the document's own state is read first (the same
    // read-only listing the owner modules use): the newest upload of the rendered document decides.
    const uploads = (await this.documents.listForOwner(entity, owner.ownerType, owner.ownerId))
      .filter((v) => v.documentId === documentId)
      .sort((a, b) => b.version - a.version);
    const newest = uploads[0];
    if (newest === undefined) throw unavailable(); // the document was removed
    if (newest.status === 'awaiting_content' || newest.status === 'quarantined') throw notReady();
    if (newest.status !== 'clean') throw unavailable(); // infected, rejected, scan_failed
    try {
      return await this.documents.issueLinkForOwner(entity, owner, documentId);
    } catch (error) {
      // Clean a moment ago, refused now (removed meanwhile, or a newer upload): the file is not available.
      if (error instanceof NotFoundException) throw unavailable();
      throw error;
    }
  }

  /**
   * Puts the PDF of a version whose render was given up back in the render queue: 202 `{ state: 'queued' }`. 403 for
   * a portal caller; 404 for a version outside the caller's quotation.send scope; 409 `quotation_pdf_retry_not_needed`
   * when the render was not given up (never failed, still being tried) or the version is not approved, so a second
   * click, or a click while the sweeper already took it, is refused and changes nothing. The state change and its
   * audit row are one transaction under the caller's scope and actor.
   */
  async retry(quotationId: string, versionId: string): Promise<QuotationPdfRetryDto> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    await withTx(this.db, scope, actor, async (tx) => {
      // A retry writes: the quotation must be inside the caller's quotation.send scope, not only quotation.read.
      const head = await this.store.head(tx, principal, quotationId, versionId, 'quotation.send');
      if (head === undefined) throw versionNotFound();
      if (!quotationRenderGivenUp(head) || head.status !== 'approved') throw retryNotNeeded();
      if (!(await this.store.requeueFailed(tx, head, versionId, new Date()))) {
        throw retryNotNeeded();
      }
      await this.audit.record(tx, {
        action: 'quotation.pdf_retry_requested',
        entityType: AUDIT_ENTITY,
        entityId: quotationId,
        before: { versionId, renderState: 'failed', renderAttempts: head.renderAttempts },
        after: { versionId, renderState: 'none', renderAttempts: 0 },
      });
    });
    // After the commit: render now instead of on the next one-minute sweep. Never throws.
    await this.renderNudge?.nudge(scope, versionId);
    return { state: 'queued' };
  }
}

function assertStaff(principal: Principal): void {
  if (principal.orgKind !== 'staff') {
    throw new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
  }
}
