// The purchase order render sweeper (worker only; P4 unit P3b): every minute it finds issued PO versions that have no
// PDF yet, renders each one (version snapshot -> allow-list view -> HTML -> Gotenberg -> PDF) and stores the PDF as a
// generated document of the version. It never runs inside the issue or amend transaction, so a slow or broken renderer
// cannot hold up or fail either.
//
// Why a sweeper and not an event: a version row is immutable (no render_state column to claim, no UPDATE for bos_app)
// and the outbox table is email-only. The whole state of a render is in `documents` (owner type
// `purchase_order_version`): a live document means "rendered, or being rendered", so a version is a candidate exactly
// when it has none. The document goes in through the documents module's generated-file path under the actor
// `system:purchase-order-render`, which PurchaseOrderVersionOwnerPolicy allows for a version of the acting entity.
//
// Claiming: the slow part (Chromium) runs with no transaction and no lock. The write is then serialised per version by
// a transaction advisory lock and a re-check for a live document, so two workers that raced both render but only one
// stores a file; the other answers `skipped`.
//
// Failures (round 4, R4c2; render-retry.ts, invoices/render/render-failures.ts): a failed render is recorded in
// `document_render_failures` and tried again after a pause that grows, until the tries run out. Then the render is
// given up, one admin (audit) entry `purchase_order.pdf_render_failed` is written on the purchase order in the same
// transaction, the candidate query leaves the version alone, and the download answers 424 so staff see the error and
// a Retry (the Retry route deletes the row). A success deletes the row. A rotating cursor keeps the oldest versions
// from filling every batch; a restart forgets only the cursor. A document created by a render that failed before its
// bytes were stored is removed in the same failure path; one left by a crash between the two steps is soft-removed
// after ORPHAN_AFTER_MS, which makes its version a candidate again.
//
// Number and date format: a delivered PO PDF is never rendered again (its document cannot be removed), so the format
// is the one in force at the first render. No snapshot column is needed. The same render freezes the company logo's
// bytes into that format (U12, see frozen-logo.ts): the PDF stored once is the frozen copy, so a later logo change or
// removal never alters it.
//
// The tests drive the sweeper through a RenderStore fake; the drizzle store below is checked by the integration test.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  SETTINGS,
  type DocumentFormatSnapshot,
} from '@bos/contracts';
import {
  documents,
  documentVersions,
  organizations,
  purchaseOrderVersions,
  purchaseOrders,
  purchaseRequests,
  scoped,
  taxCodes,
  vendors,
} from '@bos/db';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { and, asc, eq, inArray, isNull, lt, not, notExists, sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../../../platform/db/db.module';
import { systemActor, type TxScope } from '../../../../platform/db/tx';
import type { RenderAudit } from '../../../invoices/render/invoice-render.sweeper';
import { freezeEntityLogo } from '../../../invoices/render/frozen-logo';
import {
  clearRenderFailure,
  discardUnfilledDocument,
  recordRenderFailure,
  renderHeldBack,
  type RecordedFailure,
  type RenderFailureOwner,
} from '../../../invoices/render/render-failures';
import { GotenbergError } from '../../../quotations/render/gotenberg.client';
import { DocumentLogoUnavailableError } from '../../../quotations/render/issuer';
import type {
  Clock,
  PdfRenderer,
  RenderDocuments,
  RenderLogos,
  RenderSettings,
  RunInTx,
} from '../../../quotations/render/quotation-render.sweeper';
import { RENDER_GIVEN_UP_ACTION } from '../../../quotations/render/render-retry';
import { PO_AUDIT_ENTITY } from '../purchase-order.rules';
import { renderPurchaseOrderHtml } from './purchase-order-html';
import { PO_RENDER_JOB_PREFIX, PO_VERSION_OWNER_TYPE } from './purchase-order-version-owner.policy';
import {
  PurchaseOrderNotRenderableError,
  purchaseOrderPdfFilename,
  taxCodeIdsOf,
  toPurchaseOrderRenderView,
  type PurchaseOrderViewInput,
} from './purchase-order-view';

export const PO_RENDER_QUEUE = 'purchase-order.render';
export const PO_RENDER_SWEEP_JOB = 'purchase-order.render.sweep';
export const SWEEP_EVERY_MS = 60_000;
/** A generated document still awaiting its bytes after this long was left by a render that crashed midway. */
export const ORPHAN_AFTER_MS = 60 * 60_000;
/** Versions handled per tick; the rest wait a minute. Keeps one tick bounded (each render has its own deadline). */
const BATCH = 10;
const ORPHAN_BATCH = 50;

export const PO_RENDER_STORE = Symbol('PO_RENDER_STORE');
export const PO_RENDER_TX = Symbol('PO_RENDER_TX');
export const PO_RENDER_DOCUMENTS = Symbol('PO_RENDER_DOCUMENTS');
export const PO_RENDER_SETTINGS = Symbol('PO_RENDER_SETTINGS');
export const PO_RENDER_PDF = Symbol('PO_RENDER_PDF');
export const PO_RENDER_CLOCK = Symbol('PO_RENDER_CLOCK');
/** DocumentLogoResolverFactory in the worker: turns the profile's logo document into the bytes the render freezes. */
export const PO_RENDER_LOGOS = Symbol('PO_RENDER_LOGOS');
/** AuditService in the worker: writes the admin entry when a render is given up. */
export const PO_RENDER_AUDIT = Symbol('PO_RENDER_AUDIT');

export interface RenderCandidate {
  tenantId: string;
  organizationId: string;
  versionId: string;
  /** The purchase order the version belongs to: the admin entry of a given-up render is written on it. */
  purchaseOrderId: string;
}

/** What the mapper needs of a version's rows. The buying entity's PAN is read from settings by the sweeper. */
export type RenderSource = Omit<PurchaseOrderViewInput, 'buyer'> & { buyerLegalName: string };

export interface OrphanDocument {
  tenantId: string;
  organizationId: string;
  documentId: string;
}

/** The sweeper's database access, as a port. `tx` is the transaction `PO_RENDER_TX` opened for the version's scope. */
export interface RenderStore {
  /**
   * Versions with no live document that may be tried at `now` (not waiting out a failure's pause, not given up),
   * oldest first after `after`, wrapping when exhausted.
   */
  candidates(now: Date, limit: number, after?: string): Promise<RenderCandidate[]>;
  load(tx: DbTransaction, c: RenderCandidate): Promise<RenderSource | undefined>;
  /**
   * Takes this version's render lock for the rest of `tx` and answers whether it already has a live document. The
   * lock is what makes the answer stay true until the caller commits.
   */
  lockAndHasDocument(tx: DbTransaction, c: RenderCandidate): Promise<boolean>;
  orphans(cutoff: Date, limit: number): Promise<OrphanDocument[]>;
  removeOrphan(tx: DbTransaction, o: OrphanDocument, now: Date): Promise<void>;
  /** Soft-removes the version's document `documentId` when it never got its bytes (render-failures.ts). */
  discardUnfilled(
    tx: DbTransaction,
    c: RenderCandidate,
    documentId: string,
    now: Date,
  ): Promise<void>;
  /** Counts one failed try (render-failures.ts). */
  recordFailure(
    tx: DbTransaction,
    c: RenderCandidate,
    kind: string,
    now: Date,
  ): Promise<RecordedFailure>;
  /** Forgets the version's failures after a success. */
  clearFailure(tx: DbTransaction, c: RenderCandidate): Promise<void>;
}

export type RenderOutcome = 'rendered' | 'failed' | 'skipped';
export interface RenderFailure {
  versionId: string;
  /** The fixed word the log line carries (failureKind), never a message. */
  kind: string;
}
export interface SweepResult {
  rendered: number;
  failed: number;
  skipped: number;
  orphansRemoved: number;
  /** Each version that failed in this pass, so a caller (a test, an admin tool) can say why without the log. */
  failures: RenderFailure[];
}

/** The version's rows are gone or incomplete (for example no vendor), so there is nothing to render. */
export class RenderSourceMissingError extends Error {
  readonly kind = 'source_missing';
  constructor() {
    super('The purchase order version has no renderable rows');
    this.name = 'RenderSourceMissingError';
  }
}

/** A fixed word for the log: a kind, never a message (messages can carry URLs or vendor data). */
export function failureKind(error: unknown): string {
  if (error instanceof GotenbergError) return `gotenberg_${error.kind}`;
  if (
    error instanceof PurchaseOrderNotRenderableError ||
    error instanceof RenderSourceMissingError ||
    error instanceof DocumentLogoUnavailableError
  ) {
    return error.kind;
  }
  // A Nest service on the way refused (the documents module answers 400, 403 or 404): its status, not its text.
  if (error instanceof HttpException) return `http_${error.getStatus()}`;
  return 'error';
}

@Injectable()
export class PurchaseOrderRenderSweeper {
  private readonly logger = new Logger(PurchaseOrderRenderSweeper.name);
  /** The last attempted row's immutable position; one cursor rather than an unbounded attempt history. */
  private after: string | undefined;

  constructor(
    @Inject(PO_RENDER_STORE) private readonly store: RenderStore,
    @Inject(PO_RENDER_TX) private readonly runTx: RunInTx,
    @Inject(PO_RENDER_DOCUMENTS) private readonly documents: RenderDocuments,
    @Inject(PO_RENDER_SETTINGS) private readonly settings: RenderSettings,
    @Inject(PO_RENDER_PDF) private readonly pdf: PdfRenderer,
    @Inject(PO_RENDER_CLOCK) private readonly clock: Clock,
    @Inject(PO_RENDER_LOGOS) private readonly logos: RenderLogos,
    @Inject(PO_RENDER_AUDIT) private readonly audit: RenderAudit,
  ) {}

  /** One pass over every tenant: render what is due, then clean up what crashed renders left behind. */
  async sweep(): Promise<SweepResult> {
    const result: SweepResult = {
      rendered: 0,
      failed: 0,
      skipped: 0,
      orphansRemoved: 0,
      failures: [],
    };
    const candidates = await this.store.candidates(this.clock(), BATCH, this.after);
    // One at a time: Chromium is the scarce resource, and a version's failure must not touch the next one.
    for (const c of candidates) {
      const { outcome, kind } = await this.attempt(c);
      this.after = c.versionId;
      result[outcome] += 1;
      if (kind !== undefined) result.failures.push({ versionId: c.versionId, kind });
    }
    result.orphansRemoved = await this.removeOrphans();
    return result;
  }

  async renderOne(c: RenderCandidate): Promise<RenderOutcome> {
    return (await this.attempt(c)).outcome;
  }

  /** One version: its outcome and, for a failure, the kind that was logged. */
  private async attempt(c: RenderCandidate): Promise<{ outcome: RenderOutcome; kind?: string }> {
    const scope: TxScope = { tenantId: c.tenantId, organizationId: c.organizationId };
    const actor = systemActor(PO_RENDER_JOB_PREFIX);
    /** The document this try created, if it got that far: a failure after it must not leave it blocking the next. */
    let created: { documentId: string } | undefined;
    try {
      const source = await this.runTx(scope, actor, (tx) => this.store.load(tx, c));
      if (source === undefined) throw new RenderSourceMissingError();
      const { buyerLegalName, ...rows } = source;
      // A missing PAN prints nothing; it is not an error (a new entity may be pre-registration). A row that was
      // edited by hand and no longer fits the setting counts as not set.
      const pan = SETTINGS['entity.pan_vat_no'].safeParse(
        await this.settings.get(scope, 'entity.pan_vat_no'),
      );
      // An invalid value (a hand-edited row) prints the default grouping or date; it never fails the render.
      const numberSystems = SETTINGS['format.number_systems'].safeParse(
        await this.settings.get(scope, 'format.number_systems'),
      );
      const dateFormat = SETTINGS['format.date'].safeParse(
        await this.settings.get(scope, 'format.date'),
      );
      const view = toPurchaseOrderRenderView({
        ...rows,
        buyer: { legalName: buyerLegalName, panVatNo: pan.success ? pan.data : null },
      });
      // What this render prints with, frozen into the one PDF it stores. A referenced logo that cannot be read
      // fails the render (it retries later) rather than storing a logo-less PO for good.
      const format: DocumentFormatSnapshot = {
        numberSystems: numberSystems.success ? numberSystems.data : DEFAULT_NUMBER_SYSTEMS,
        dateFormat: dateFormat.success ? dateFormat.data : DEFAULT_DATE_FORMAT,
        logoDataUrl: await freezeEntityLogo(this.settings, this.logos, scope),
        capturedAt: this.clock().toISOString(),
      };
      const bytes = await this.pdf.htmlToPdf(
        renderPurchaseOrderHtml(view, {
          numberSystems: format.numberSystems,
          dateFormat: format.dateFormat,
          logoDataUrl: format.logoDataUrl ?? null,
        }),
      );
      const file = {
        filename: purchaseOrderPdfFilename(view.number, view.version),
        declaredMime: 'application/pdf',
        bytes,
      };

      // The lock and the re-check make "no live document yet" true until this commits, so only one racer stores.
      const generated = await this.runTx(scope, actor, async (tx) =>
        (await this.store.lockAndHasDocument(tx, c))
          ? undefined
          : this.documents.createGenerated(
              tx,
              { ownerType: PO_VERSION_OWNER_TYPE, ownerId: c.versionId },
              file,
            ),
      );
      if (generated === undefined) return { outcome: 'skipped' };
      created = generated;
      // After the commit above: the content step opens its own transactions and the scan worker reads the row.
      await this.documents.receiveGenerated(generated, file, { scope, actor });
      await this.runTx(scope, actor, (tx) => this.store.clearFailure(tx, c));
      return { outcome: 'rendered' };
    } catch (error) {
      const kind = failureKind(error);
      this.logger.warn(`purchase order render failed: version=${c.versionId} kind=${kind}`);
      await this.noteFailure(c, scope, kind, created);
      return { outcome: 'failed', kind };
    }
  }

  /**
   * Records a failed try, in one transaction: removes the document this try created if it never got its bytes, counts
   * the failure, and, when that used up the last try, writes the admin entry on the purchase order. A failure here is
   * logged and left to the next sweep.
   */
  private async noteFailure(
    c: RenderCandidate,
    scope: TxScope,
    kind: string,
    created: { documentId: string } | undefined,
  ): Promise<void> {
    try {
      await this.runTx(scope, systemActor(PO_RENDER_JOB_PREFIX), async (tx) => {
        const now = this.clock();
        if (created !== undefined) await this.store.discardUnfilled(tx, c, created.documentId, now);
        const recorded = await this.store.recordFailure(tx, c, kind, now);
        if (!recorded.givenUp) return;
        await this.audit.record(tx, {
          action: RENDER_GIVEN_UP_ACTION.purchase_order,
          entityType: PO_AUDIT_ENTITY,
          entityId: c.purchaseOrderId,
          after: { versionId: c.versionId, attempts: recorded.attempts, failureKind: kind },
        });
        this.logger.error(
          `purchase order render given up: version=${c.versionId} attempts=${recorded.attempts} kind=${kind}`,
        );
      });
    } catch (error) {
      this.logger.error(
        `purchase order render: could not record the failure: version=${c.versionId} kind=${failureKind(error)}`,
      );
    }
  }

  /** Generated documents that never got their bytes (the render crashed between the two steps) are soft-removed. */
  private async removeOrphans(): Promise<number> {
    const now = this.clock();
    const orphans = await this.store.orphans(
      new Date(now.getTime() - ORPHAN_AFTER_MS),
      ORPHAN_BATCH,
    );
    let removed = 0;
    for (const o of orphans) {
      try {
        const scope: TxScope = { tenantId: o.tenantId, organizationId: o.organizationId };
        await this.runTx(scope, systemActor(PO_RENDER_JOB_PREFIX), (tx) =>
          this.store.removeOrphan(tx, o, now),
        );
        removed += 1;
      } catch (error) {
        this.logger.error(
          `purchase order render: could not remove an orphan document: document=${o.documentId} kind=${failureKind(error)}`,
        );
      }
    }
    return removed;
  }
}

const ownerOf = (c: RenderCandidate): RenderFailureOwner => ({
  tenantId: c.tenantId,
  organizationId: c.organizationId,
  ownerType: PO_VERSION_OWNER_TYPE,
  ownerId: c.versionId,
});

/** The store on the real tables. Every query names the tenant and the acting entity. */
export function drizzlePurchaseOrderRenderStore(db: Db): RenderStore {
  return {
    async candidates(now, limit, after) {
      const hasLiveDocument = db
        .select({ one: sql`1` })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, purchaseOrderVersions.tenantId),
            eq(documents.organizationId, purchaseOrderVersions.organizationId),
            eq(documents.ownerType, PO_VERSION_OWNER_TYPE),
            eq(documents.ownerId, purchaseOrderVersions.id),
            isNull(documents.removedAt),
          ),
        );
      const page = (cursor?: string) =>
        db
          .select({
            tenantId: purchaseOrderVersions.tenantId,
            organizationId: purchaseOrderVersions.organizationId,
            versionId: purchaseOrderVersions.id,
            purchaseOrderId: purchaseOrderVersions.purchaseOrderId,
          })
          .from(purchaseOrderVersions)
          .where(
            and(
              notExists(hasLiveDocument),
              not(
                renderHeldBack(
                  db,
                  PO_VERSION_OWNER_TYPE,
                  {
                    tenantId: purchaseOrderVersions.tenantId,
                    organizationId: purchaseOrderVersions.organizationId,
                    id: purchaseOrderVersions.id,
                  },
                  now,
                ),
              ),
              cursor === undefined
                ? undefined
                : sql`(${purchaseOrderVersions.createdAt}, ${purchaseOrderVersions.id}) >
                    (SELECT created_at, id FROM ${purchaseOrderVersions} WHERE id = ${cursor})`,
            ),
          )
          .orderBy(asc(purchaseOrderVersions.createdAt), asc(purchaseOrderVersions.id))
          .limit(limit);
      // Read the cursor row independently of document eligibility. A rendered or removed cursor still advances;
      // a missing cursor yields an empty page and safely restarts from the beginning.
      const next = await page(after);
      return next.length > 0 || after === undefined ? next : page();
    },

    async load(tx, c) {
      const scope = { tenantId: c.tenantId, organizationId: c.organizationId };
      const s = scoped(scope);
      const [version] = await tx
        .select({
          purchaseOrderId: purchaseOrderVersions.purchaseOrderId,
          version: purchaseOrderVersions.version,
          createdAt: purchaseOrderVersions.createdAt,
          total: purchaseOrderVersions.total,
          snapshot: purchaseOrderVersions.snapshot,
        })
        .from(purchaseOrderVersions)
        .where(s.where(purchaseOrderVersions, eq(purchaseOrderVersions.id, c.versionId)))
        .limit(1);
      if (version === undefined) return undefined;

      const [po] = await tx
        .select({
          vendorId: purchaseOrders.vendorId,
          purchaseRequestId: purchaseOrders.purchaseRequestId,
        })
        .from(purchaseOrders)
        .where(s.where(purchaseOrders, eq(purchaseOrders.id, version.purchaseOrderId)))
        .limit(1);
      if (po === undefined) return undefined;
      // vendors and tax_codes are tenant-level tables: keyed by tenant and id.
      const [vendor] = await tx
        .select({ legalName: vendors.legalName, pan: vendors.pan })
        .from(vendors)
        .where(and(eq(vendors.tenantId, c.tenantId), eq(vendors.id, po.vendorId)))
        .limit(1);
      const [org] = await tx
        .select({ legalName: organizations.legalName })
        .from(organizations)
        .where(and(eq(organizations.tenantId, c.tenantId), eq(organizations.id, c.organizationId)))
        .limit(1);
      if (vendor === undefined || org === undefined) return undefined;
      const [request] = await tx
        .select({
          requiredBy: purchaseRequests.requiredBy,
          deliveryLocation: purchaseRequests.deliveryLocation,
        })
        .from(purchaseRequests)
        .where(s.where(purchaseRequests, eq(purchaseRequests.id, po.purchaseRequestId)))
        .limit(1);
      const codeIds = taxCodeIdsOf(version.snapshot);
      const codes =
        codeIds.length === 0
          ? []
          : await tx
              .select({ id: taxCodes.id, code: taxCodes.code })
              .from(taxCodes)
              .where(and(eq(taxCodes.tenantId, c.tenantId), inArray(taxCodes.id, codeIds)));

      return {
        buyerLegalName: org.legalName,
        version: {
          version: version.version,
          createdAt: version.createdAt,
          total: version.total,
          snapshot: version.snapshot,
        },
        vendor,
        delivery: {
          requiredBy: request?.requiredBy ?? null,
          deliveryLocation: request?.deliveryLocation ?? null,
        },
        taxCodes: new Map(codes.map((t) => [t.id, t.code])),
      };
    },

    async lockAndHasDocument(tx, c) {
      // Two renders of one version queue here; the second then sees the first one's document.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`purchase-order-render:${c.versionId}`}))`,
      );
      const [found] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          scoped({ tenantId: c.tenantId, organizationId: c.organizationId }).where(
            documents,
            and(
              eq(documents.ownerType, PO_VERSION_OWNER_TYPE),
              eq(documents.ownerId, c.versionId),
              isNull(documents.removedAt),
            ),
          ),
        )
        .limit(1);
      return found !== undefined;
    },

    discardUnfilled(tx, c, documentId, now) {
      return discardUnfilledDocument(tx, ownerOf(c), documentId, now);
    },

    recordFailure(tx, c, kind, now) {
      return recordRenderFailure(tx, ownerOf(c), kind, now);
    },

    clearFailure(tx, c) {
      return clearRenderFailure(tx, ownerOf(c));
    },

    async orphans(cutoff, limit) {
      return db
        .select({
          tenantId: documents.tenantId,
          organizationId: documents.organizationId,
          documentId: documents.id,
        })
        .from(documents)
        .innerJoin(
          documentVersions,
          and(
            eq(documentVersions.tenantId, documents.tenantId),
            eq(documentVersions.documentId, documents.id),
          ),
        )
        .where(
          and(
            eq(documents.ownerType, PO_VERSION_OWNER_TYPE),
            isNull(documents.removedAt),
            lt(documents.createdAt, cutoff),
            eq(documentVersions.status, 'awaiting_content'),
          ),
        )
        .orderBy(asc(documents.createdAt))
        .limit(limit);
    },

    async removeOrphan(tx, o, now) {
      // Soft remove, like DocumentsService.remove (which refuses here: nobody removes a PO file by hand). Rows are
      // kept for the audit trail, and there are no bytes to delete: the version never left awaiting_content.
      await tx
        .update(documents)
        .set({ removedAt: now, updatedAt: now })
        .where(
          and(
            eq(documents.tenantId, o.tenantId),
            eq(documents.organizationId, o.organizationId),
            eq(documents.id, o.documentId),
            isNull(documents.removedAt),
          ),
        );
    },
  };
}

@Processor(PO_RENDER_QUEUE)
export class PurchaseOrderRenderProcessor extends WorkerHost {
  constructor(private readonly sweeper: PurchaseOrderRenderSweeper) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === PO_RENDER_SWEEP_JOB) {
      await this.sweeper.sweep();
      return;
    }
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    throw new Error(`Unknown purchase order render job: ${job.name}`);
  }
}

/** Registers the one-minute sweep. upsertJobScheduler is idempotent, so restarts never stack schedules. */
@Injectable()
export class PurchaseOrderRenderScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(PO_RENDER_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PO_RENDER_SWEEP_JOB,
      { every: SWEEP_EVERY_MS },
      { name: PO_RENDER_SWEEP_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
