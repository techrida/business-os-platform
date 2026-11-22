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
// after ORPHAN_AFTER_MS, which makes its version a candidate again. That removal counts as one failed try (kind
// `abandoned`, in the same transaction), so a worker that crashes on every try ends given up instead of looping.
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
  organizations,
  purchaseOrderVersions,
  purchaseOrders,
  purchaseRequests,
  scoped,
  taxCodes,
  vendorContactPhones,
  vendorContacts,
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
import { and, asc, eq, exists, inArray, isNull, lt, not, notExists, sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../../../platform/db/db.module';
import { READ_ONLY, systemActor, type TxScope } from '../../../../platform/db/tx';
import { freezeEntityLogo } from '../../../invoices/render/frozen-logo';
import {
  clearRenderFailure,
  discardUnfilledDocument,
  filledVersion,
  recordRenderFailure,
  renderHeldBack,
  unrefusedUpload,
  type RecordedFailure,
  type RenderFailureOwner,
} from '../../../invoices/render/render-failures';
import { GotenbergError } from '../../../quotations/render/gotenberg.client';
import { DocumentLogoUnavailableError } from '../../../quotations/render/issuer';
import {
  ABANDONED_KIND,
  type Clock,
  type PdfRenderer,
  type RenderAudit,
  type RenderDocuments,
  type RenderLogos,
  type RenderSettings,
  type RunInTx,
} from '../../../quotations/render/quotation-render.sweeper';
import {
  GENERATED_ORPHAN_AFTER_MS,
  RENDER_GIVEN_UP_ACTION,
} from '../../../quotations/render/render-retry';
import { PO_AUDIT_ENTITY } from '../purchase-order.rules';
import { RenderOneJobSchema } from '../../../quotations/render/render-nudge';
import { renderPurchaseOrderHtml } from './purchase-order-html';
import { PO_RENDER_ONE_JOB, PO_RENDER_QUEUE } from './purchase-order-render.nudge';
import { PO_RENDER_JOB_PREFIX, PO_VERSION_OWNER_TYPE } from './purchase-order-version-owner.policy';
import {
  PurchaseOrderNotRenderableError,
  purchaseOrderPdfFilename,
  taxCodeIdsOf,
  toPurchaseOrderRenderView,
  type PurchaseOrderViewInput,
} from './purchase-order-view';

export { PO_RENDER_ONE_JOB, PO_RENDER_QUEUE } from './purchase-order-render.nudge';
export const PO_RENDER_SWEEP_JOB = 'purchase-order.render.sweep';
export const SWEEP_EVERY_MS = 60_000;
/** A generated document still without its bytes after this long was left by a render that crashed midway. */
export const ORPHAN_AFTER_MS = GENERATED_ORPHAN_AFTER_MS;
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

/** What the mapper needs of a version's rows. The buying entity's PAN and country are read from settings by the sweeper. */
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
  /** This order's versions that are candidates at `now`, by the same rule as `candidates`, oldest first. */
  candidatesOf(scope: TxScope, purchaseOrderId: string, now: Date): Promise<RenderCandidate[]>;
  load(tx: DbTransaction, c: RenderCandidate): Promise<RenderSource | undefined>;
  /**
   * Takes this version's render lock for the rest of `tx` and answers whether it already has a live document. The
   * lock is what makes the answer stay true until the caller commits.
   */
  lockAndHasDocument(tx: DbTransaction, c: RenderCandidate): Promise<boolean>;
  orphans(cutoff: Date, limit: number): Promise<OrphanDocument[]>;
  /**
   * Soft-removes the orphan if it is still live and still has no bytes, and answers whose it was; undefined when
   * there was nothing to remove (the bytes landed meanwhile, or another worker removed it first).
   */
  removeOrphan(
    tx: DbTransaction,
    o: OrphanDocument,
    now: Date,
  ): Promise<RenderCandidate | undefined>;
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

  /**
   * The render a commit asked for (`purchase-order.render.one`): the order's versions that are candidates now, one at
   * a time (normally just the version the commit created). None is fine: the sweep got there first, the PDF is live,
   * or a failure's pause is running; the sweep stays the safety net.
   */
  async renderNow(scope: TxScope, purchaseOrderId: string): Promise<RenderOutcome[]> {
    const outcomes: RenderOutcome[] = [];
    for (const c of await this.store.candidatesOf(scope, purchaseOrderId, this.clock())) {
      outcomes.push((await this.attempt(c)).outcome);
    }
    return outcomes;
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
      const source = await this.runTx(scope, actor, (tx) => this.store.load(tx, c), READ_ONLY);
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
      // The entity's own country, through the same setting the quotation issuer reads: a vendor there prints no
      // country line. An unset or invalid address is not an error here (the PO does not print the buyer's address);
      // the vendor's country then always prints.
      const address = SETTINGS['entity.address'].safeParse(
        await this.settings.get(scope, 'entity.address'),
      );
      const view = toPurchaseOrderRenderView({
        ...rows,
        buyer: {
          legalName: buyerLegalName,
          panVatNo: pan.success ? pan.data : null,
          country: address.success && address.data !== null ? address.data.country : null,
        },
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
      // The PDF is stored: the render succeeded even if its earlier failures cannot be forgotten now. Counting that as
      // a failed try could give up a render whose PDF exists; a leftover row is harmless behind a live document.
      try {
        await this.runTx(scope, actor, (tx) => this.store.clearFailure(tx, c));
      } catch (error) {
        this.logger.error(
          `purchase order render: could not forget earlier failures: version=${c.versionId} kind=${failureKind(error)}`,
        );
      }
      return { outcome: 'rendered' };
    } catch (error) {
      const kind = failureKind(error);
      this.logger.warn(`purchase order render failed: version=${c.versionId} kind=${kind}`);
      await this.noteFailure(c, scope, kind, created);
      return { outcome: 'failed', kind };
    }
  }

  /**
   * Records a failed try. First, in its own transaction, removes the document this try created if it never got its
   * bytes. Then, in another, counts the failure and, when that used up the last try, writes the admin entry on the
   * purchase order. Apart, so that one failing does not undo the other: a document left live would keep the version
   * out of the candidates until the orphan cleanup. A failure of either is logged and left to the next sweep.
   */
  private async noteFailure(
    c: RenderCandidate,
    scope: TxScope,
    kind: string,
    created: { documentId: string } | undefined,
  ): Promise<void> {
    const actor = systemActor(PO_RENDER_JOB_PREFIX);
    if (created !== undefined) {
      try {
        await this.runTx(scope, actor, (tx) =>
          this.store.discardUnfilled(tx, c, created.documentId, this.clock()),
        );
      } catch (error) {
        this.logger.error(
          `purchase order render: could not remove the failed try's document: version=${c.versionId} kind=${failureKind(error)}`,
        );
      }
    }
    try {
      await this.runTx(scope, actor, (tx) => this.countFailure(tx, c, kind, this.clock()));
    } catch (error) {
      this.logger.error(
        `purchase order render: could not record the failure: version=${c.versionId} kind=${failureKind(error)}`,
      );
    }
  }

  /** Counts one failed try in `tx` and, when that used up the last one, writes the admin entry on the PO there too. */
  private async countFailure(
    tx: DbTransaction,
    c: RenderCandidate,
    kind: string,
    now: Date,
  ): Promise<void> {
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
  }

  /**
   * Generated documents that never got their bytes (the render crashed between the two steps) are soft-removed. The
   * crashed render never counted its try, so the removal counts it, in the same transaction: a worker that dies on
   * every try is given up at the limit, like any failure, and the removal is undone if the count cannot be written.
   */
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
        const owner = await this.runTx(scope, systemActor(PO_RENDER_JOB_PREFIX), async (tx) => {
          const removedFrom = await this.store.removeOrphan(tx, o, now);
          if (removedFrom !== undefined)
            await this.countFailure(tx, removedFrom, ABANDONED_KIND, now);
          return removedFrom;
        });
        if (owner === undefined) continue;
        this.logger.warn(
          `purchase order render failed: version=${owner.versionId} kind=${ABANDONED_KIND}`,
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

const CANDIDATE_COLUMNS = {
  tenantId: purchaseOrderVersions.tenantId,
  organizationId: purchaseOrderVersions.organizationId,
  versionId: purchaseOrderVersions.id,
  purchaseOrderId: purchaseOrderVersions.purchaseOrderId,
};

/**
 * The candidate rule, on the outer `purchase_order_versions` row: no live document that holds or awaits a PDF, and not
 * held back by a failure (pausing or given up).
 */
function renderDue(db: Db, now: Date) {
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
        exists(unrefusedUpload(db, documents.tenantId, documents.id)),
      ),
    );
  return and(
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
  );
}

/** The store on the real tables. Every query names the tenant and the acting entity. */
export function drizzlePurchaseOrderRenderStore(db: Db): RenderStore {
  return {
    async candidates(now, limit, after) {
      const page = (cursor?: string) =>
        db
          .select(CANDIDATE_COLUMNS)
          .from(purchaseOrderVersions)
          .where(
            and(
              renderDue(db, now),
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

    async candidatesOf(scope, purchaseOrderId, now) {
      return db
        .select(CANDIDATE_COLUMNS)
        .from(purchaseOrderVersions)
        .where(
          and(
            eq(purchaseOrderVersions.tenantId, scope.tenantId),
            eq(purchaseOrderVersions.organizationId, scope.organizationId),
            eq(purchaseOrderVersions.purchaseOrderId, purchaseOrderId),
            renderDue(db, now),
          ),
        )
        .orderBy(asc(purchaseOrderVersions.createdAt), asc(purchaseOrderVersions.id));
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
      const [vendorRow] = await tx
        .select({
          legalName: vendors.legalName,
          pan: vendors.pan,
          country: vendors.country,
          addressLine: vendors.addressLine,
          addressCity: vendors.addressCity,
        })
        .from(vendors)
        .where(and(eq(vendors.tenantId, c.tenantId), eq(vendors.id, po.vendorId)))
        .limit(1);
      // The phone the PO prints: the primary number of the vendor's primary contact (at most one of each, by
      // partial unique index). Contacts and their phones are tenant-level too.
      const [phone] = await tx
        .select({ e164: vendorContactPhones.e164 })
        .from(vendorContacts)
        .innerJoin(
          vendorContactPhones,
          and(
            eq(vendorContactPhones.tenantId, vendorContacts.tenantId),
            eq(vendorContactPhones.contactId, vendorContacts.id),
          ),
        )
        .where(
          and(
            eq(vendorContacts.tenantId, c.tenantId),
            eq(vendorContacts.vendorId, po.vendorId),
            eq(vendorContacts.isPrimary, true),
            eq(vendorContactPhones.isPrimary, true),
          ),
        )
        .limit(1);
      const vendor =
        vendorRow === undefined ? undefined : { ...vendorRow, phoneE164: phone?.e164 ?? null };
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
              exists(unrefusedUpload(tx, documents.tenantId, documents.id)),
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
        .where(
          and(
            eq(documents.ownerType, PO_VERSION_OWNER_TYPE),
            isNull(documents.removedAt),
            lt(documents.createdAt, cutoff),
            notExists(filledVersion(db, documents.tenantId, documents.id)),
          ),
        )
        .orderBy(asc(documents.createdAt))
        .limit(limit);
    },

    async removeOrphan(tx, o, now) {
      // Soft remove, like DocumentsService.remove (which refuses here: nobody removes a PO file by hand). Rows are
      // kept for the audit trail, and there are no bytes to delete: the version is awaiting_content or rejected.
      const [removed] = await tx
        .update(documents)
        .set({ removedAt: now, updatedAt: now })
        .where(
          and(
            eq(documents.tenantId, o.tenantId),
            eq(documents.organizationId, o.organizationId),
            eq(documents.id, o.documentId),
            // The owner it answers with is a PO version: never touch another owner type's document.
            eq(documents.ownerType, PO_VERSION_OWNER_TYPE),
            isNull(documents.removedAt),
            // Re-checked here: the bytes may have landed between the listing and this update.
            notExists(filledVersion(tx, documents.tenantId, documents.id)),
          ),
        )
        .returning({ versionId: documents.ownerId });
      if (removed === undefined) return undefined;
      const scope = { tenantId: o.tenantId, organizationId: o.organizationId };
      const [version] = await tx
        .select({ purchaseOrderId: purchaseOrderVersions.purchaseOrderId })
        .from(purchaseOrderVersions)
        .where(
          scoped(scope).where(
            purchaseOrderVersions,
            eq(purchaseOrderVersions.id, removed.versionId),
          ),
        )
        .limit(1);
      // The version row is immutable and its document points at it, so it is there; without it nothing is counted.
      return version === undefined
        ? undefined
        : { ...scope, versionId: removed.versionId, purchaseOrderId: version.purchaseOrderId };
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
    if (job.name === PO_RENDER_ONE_JOB) {
      const { tenantId, organizationId, id } = RenderOneJobSchema.parse(job.data);
      await this.sweeper.renderNow({ tenantId, organizationId }, id);
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
