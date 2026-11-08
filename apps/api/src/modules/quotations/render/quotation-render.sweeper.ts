// The quotation render sweeper (worker only): every minute it finds approved quotation versions that have no PDF
// yet, renders each one (customer view -> HTML -> Gotenberg -> PDF), stores the PDF as a generated document of
// the version, and records it on the version. It never runs inside the approval decision, so a slow or broken
// renderer cannot hold up or fail an approval (NFR "a render can never block a decision").
//
// Safe to repeat and to run on two workers at once: every version is first claimed with one conditional UPDATE
// (render_state -> 'pending'), and only the claimant renders. A claim older than 10 minutes counts as abandoned
// (the worker died) and is taken again; a failed version is retried after a short pause. The file goes in through
// the documents module's generated-file path under the actor `system:quotation-render`, which the owner policy
// allows only for an approved version, so the PDF is of exactly the content that was approved.
//
// The tests drive the sweeper through a RenderStore fake; the drizzle store below is checked by the R3
// integration test against a real database.
import { createHash } from 'node:crypto';

import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  customerContacts,
  customers,
  documents,
  documentVersions,
  organizations,
  paymentTerms,
  quotationLines,
  quotations,
  quotationTaxSummary,
  quotationVersions,
} from '@bos/db';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { type Actor, systemActor, type TxScope } from '../../../platform/db/tx';
import type { DocumentsService } from '../../../platform/documents/documents.service';
import type { SettingsService } from '../../../platform/settings/settings.service';
import { QUOTATION_OWNER_TYPE, QUOTATION_RENDER_JOB_PREFIX } from '../quotation-owner.policy';
import {
  quotationPdfFilename,
  toCustomerQuotationView,
  type CustomerViewInput,
} from './customer-view';
import { GotenbergError } from './gotenberg.client';
import { buildIssuer, IssuerIncompleteError } from './issuer';
import { renderQuotationHtml } from './quotation-html';

export const QUOTATION_RENDER_QUEUE = 'quotation.render';
export const QUOTATION_RENDER_SWEEP_JOB = 'quotation.render.sweep';
export const SWEEP_EVERY_MS = 60_000;
/** A version still `pending` after this long was claimed by a worker that died; it is taken again. */
export const PENDING_STALE_MS = 10 * 60_000;
/** A failed version waits this long before the next try, so a permanent fault does not hammer Gotenberg. */
export const FAILED_RETRY_MS = 5 * 60_000;
/** A generated document still awaiting its bytes after this long was left by a render that crashed midway. */
export const ORPHAN_AFTER_MS = 60 * 60_000;
/** Versions handled per tick; the rest wait a minute. Keeps one tick bounded (each render has its own deadline). */
const BATCH = 10;
const ORPHAN_BATCH = 50;

export const RENDER_STORE = Symbol('QUOTATION_RENDER_STORE');
export const RENDER_TX = Symbol('QUOTATION_RENDER_TX');
export const RENDER_DOCUMENTS = Symbol('QUOTATION_RENDER_DOCUMENTS');
export const RENDER_SETTINGS = Symbol('QUOTATION_RENDER_SETTINGS');
export const RENDER_PDF = Symbol('QUOTATION_RENDER_PDF');
export const RENDER_CLOCK = Symbol('QUOTATION_RENDER_CLOCK');

export interface RenderCandidate {
  tenantId: string;
  organizationId: string;
  versionId: string;
}

/** What the mapper needs of a version's rows, plus the issuing entity's legal name. */
export type RenderSource = Omit<CustomerViewInput, 'issuer' | 'renderedScanClean'> & {
  issuerLegalName: string;
};

export interface OrphanDocument {
  tenantId: string;
  organizationId: string;
  documentId: string;
}

/** The sweeper's database access, as a port. `tx` is the transaction `RENDER_TX` opened for the version's scope. */
export interface RenderStore {
  /** Approved versions that need a render now, oldest first. */
  candidates(now: Date, limit: number): Promise<RenderCandidate[]>;
  /** One conditional UPDATE: true only for the caller that moved the version to `pending`. */
  claim(tx: DbTransaction, c: RenderCandidate, now: Date): Promise<boolean>;
  load(tx: DbTransaction, c: RenderCandidate): Promise<RenderSource | undefined>;
  markRendered(
    tx: DbTransaction,
    c: RenderCandidate,
    rendered: { documentId: string; sha256: Buffer },
    now: Date,
  ): Promise<void>;
  /** Only a version still `pending` becomes `failed`: one that finished meanwhile is left alone. */
  markFailed(tx: DbTransaction, c: RenderCandidate, now: Date): Promise<void>;
  orphans(cutoff: Date, limit: number): Promise<OrphanDocument[]>;
  removeOrphan(tx: DbTransaction, o: OrphanDocument, now: Date): Promise<void>;
}

export type RunInTx = <T>(
  scope: TxScope,
  actor: Actor,
  fn: (tx: DbTransaction) => Promise<T>,
) => Promise<T>;
export type RenderDocuments = Pick<DocumentsService, 'createGenerated' | 'receiveGenerated'>;
export type RenderSettings = Pick<SettingsService, 'get'>;
export interface PdfRenderer {
  htmlToPdf(html: string): Promise<Buffer>;
}
export type Clock = () => Date;

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

/** The version's rows are gone or incomplete (for example no customer), so there is nothing to render. */
export class RenderSourceMissingError extends Error {
  readonly kind = 'source_missing';
  constructor() {
    super('The quotation version has no renderable rows');
    this.name = 'RenderSourceMissingError';
  }
}

/** A fixed word for the log: a kind, never a message (messages can carry URLs or customer data). */
export function failureKind(error: unknown): string {
  if (error instanceof GotenbergError) return `gotenberg_${error.kind}`;
  if (error instanceof IssuerIncompleteError || error instanceof RenderSourceMissingError) {
    return error.kind;
  }
  // A Nest service on the way refused (the documents module answers 400, 403 or 404): its status, not its text.
  if (error instanceof HttpException) return `http_${error.getStatus()}`;
  return 'error';
}

@Injectable()
export class QuotationRenderSweeper {
  private readonly logger = new Logger(QuotationRenderSweeper.name);

  constructor(
    @Inject(RENDER_STORE) private readonly store: RenderStore,
    @Inject(RENDER_TX) private readonly runTx: RunInTx,
    @Inject(RENDER_DOCUMENTS) private readonly documents: RenderDocuments,
    @Inject(RENDER_SETTINGS) private readonly settings: RenderSettings,
    @Inject(RENDER_PDF) private readonly pdf: PdfRenderer,
    @Inject(RENDER_CLOCK) private readonly clock: Clock,
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
    const candidates = await this.store.candidates(this.clock(), BATCH);
    // One at a time: Chromium is the scarce resource, and a version's failure must not touch the next one.
    for (const c of candidates) {
      const { outcome, kind } = await this.attempt(c);
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
    const actor = systemActor(QUOTATION_RENDER_JOB_PREFIX);

    // The claim is its own transaction, committed before the slow part, so other workers see `pending`.
    const claimed = await this.runTx(scope, actor, (tx) => this.store.claim(tx, c, this.clock()));
    if (!claimed) return { outcome: 'skipped' };

    try {
      const source = await this.runTx(scope, actor, (tx) => this.store.load(tx, c));
      if (source === undefined) throw new RenderSourceMissingError();
      const { issuerLegalName, ...rows } = source;
      const issuer = await buildIssuer(this.settings, scope, issuerLegalName);
      // The `render` purpose lets the mapper draw an approved version (a customer cannot see one) as the
      // document that will be sent. The file field stays null: this PDF is not its own attachment.
      const view = toCustomerQuotationView(
        { ...rows, issuer, renderedScanClean: false },
        { purpose: 'render' },
      );
      const bytes = await this.pdf.htmlToPdf(renderQuotationHtml(view));
      const file = {
        filename: quotationPdfFilename(rows.quotation.number, rows.version.revisionNo),
        declaredMime: 'application/pdf',
        bytes,
      };

      const created = await this.runTx(scope, actor, (tx) =>
        this.documents.createGenerated(
          tx,
          { ownerType: QUOTATION_OWNER_TYPE, ownerId: c.versionId },
          file,
        ),
      );
      // After the commit above: the content step opens its own transactions and the scan worker reads the row.
      await this.documents.receiveGenerated(created, file, { scope, actor });

      const sha256 = createHash('sha256').update(bytes).digest();
      await this.runTx(scope, actor, (tx) =>
        this.store.markRendered(tx, c, { documentId: created.documentId, sha256 }, this.clock()),
      );
      return { outcome: 'rendered' };
    } catch (error) {
      const kind = failureKind(error);
      this.logger.warn(`quotation render failed: version=${c.versionId} kind=${kind}`);
      try {
        await this.runTx(scope, actor, (tx) => this.store.markFailed(tx, c, this.clock()));
      } catch (markError) {
        this.logger.error(
          `quotation render: could not record the failure: version=${c.versionId} kind=${failureKind(markError)}`,
        );
      }
      return { outcome: 'failed', kind };
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
        await this.runTx(scope, systemActor(QUOTATION_RENDER_JOB_PREFIX), (tx) =>
          this.store.removeOrphan(tx, o, now),
        );
        removed += 1;
      } catch (error) {
        this.logger.error(
          `quotation render: could not remove an orphan document: document=${o.documentId} kind=${failureKind(error)}`,
        );
      }
    }
    return removed;
  }
}

/** The store on the real tables. Every query names the tenant and the acting entity. */
export function drizzleRenderStore(db: Db): RenderStore {
  const ownVersion = (c: RenderCandidate) =>
    and(
      eq(quotationVersions.tenantId, c.tenantId),
      eq(quotationVersions.organizationId, c.organizationId),
      eq(quotationVersions.id, c.versionId),
    );
  /** None, failed a while ago, or pending since a worker died. */
  const needsRender = (now: Date) =>
    or(
      eq(quotationVersions.renderState, 'none'),
      and(
        eq(quotationVersions.renderState, 'failed'),
        lt(quotationVersions.updatedAt, new Date(now.getTime() - FAILED_RETRY_MS)),
      ),
      and(
        eq(quotationVersions.renderState, 'pending'),
        lt(quotationVersions.updatedAt, new Date(now.getTime() - PENDING_STALE_MS)),
      ),
    );

  return {
    async candidates(now, limit) {
      return db
        .select({
          tenantId: quotationVersions.tenantId,
          organizationId: quotationVersions.organizationId,
          versionId: quotationVersions.id,
        })
        .from(quotationVersions)
        .where(and(eq(quotationVersions.status, 'approved'), needsRender(now)))
        .orderBy(asc(quotationVersions.updatedAt))
        .limit(limit);
    },

    async claim(tx, c, now) {
      const rows = await tx
        .update(quotationVersions)
        .set({ renderState: 'pending', updatedAt: now })
        .where(and(ownVersion(c), eq(quotationVersions.status, 'approved'), needsRender(now)))
        .returning({ id: quotationVersions.id });
      return rows.length === 1;
    },

    async load(tx, c) {
      const [version] = await tx
        .select({
          id: quotationVersions.id,
          quotationId: quotationVersions.quotationId,
          revisionNo: quotationVersions.revisionNo,
          status: quotationVersions.status,
          rejectionSource: quotationVersions.rejectionSource,
          contactId: quotationVersions.contactId,
          paymentTermId: quotationVersions.paymentTermId,
          currency: quotationVersions.currency,
          issueDate: quotationVersions.issueDate,
          validUntil: quotationVersions.validUntil,
          scope: quotationVersions.scope,
          assumptions: quotationVersions.assumptions,
          exclusions: quotationVersions.exclusions,
          deliveryTimeline: quotationVersions.deliveryTimeline,
          paymentSchedule: quotationVersions.paymentSchedule,
          subtotal: quotationVersions.subtotal,
          discountAmount: quotationVersions.discountAmount,
          taxableAmount: quotationVersions.taxableAmount,
          taxAmount: quotationVersions.taxAmount,
          total: quotationVersions.total,
          renderState: quotationVersions.renderState,
          renderedDocumentId: quotationVersions.renderedDocumentId,
          renderedSha256: quotationVersions.renderedSha256,
        })
        .from(quotationVersions)
        .where(ownVersion(c))
        .limit(1);
      if (version === undefined) return undefined;

      const [quotation] = await tx
        .select({ number: quotations.number, customerPartyId: quotations.customerPartyId })
        .from(quotations)
        .where(
          and(
            eq(quotations.tenantId, c.tenantId),
            eq(quotations.organizationId, c.organizationId),
            eq(quotations.id, version.quotationId),
          ),
        )
        .limit(1);
      if (quotation === undefined || quotation.customerPartyId === null) return undefined;

      const [customer] = await tx
        .select({
          legalName: customers.legalName,
          panVatNo: customers.panVatNo,
          address: customers.address,
        })
        .from(customers)
        .where(and(eq(customers.tenantId, c.tenantId), eq(customers.id, quotation.customerPartyId)))
        .limit(1);
      if (customer === undefined) return undefined;

      let contact: RenderSource['contact'] = null;
      if (version.contactId !== null) {
        [contact = null] = await tx
          .select({ fullName: customerContacts.fullName, emailNorm: customerContacts.emailNorm })
          .from(customerContacts)
          .where(
            and(
              eq(customerContacts.tenantId, c.tenantId),
              eq(customerContacts.id, version.contactId),
            ),
          )
          .limit(1);
      }
      let paymentTerm: RenderSource['paymentTerm'] = null;
      if (version.paymentTermId !== null) {
        [paymentTerm = null] = await tx
          .select({ name: paymentTerms.name })
          .from(paymentTerms)
          .where(
            and(eq(paymentTerms.tenantId, c.tenantId), eq(paymentTerms.id, version.paymentTermId)),
          )
          .limit(1);
      }

      const lines = await tx
        .select({
          lineNo: quotationLines.lineNo,
          description: quotationLines.description,
          uom: quotationLines.uom,
          quantity: quotationLines.quantity,
          unitPrice: quotationLines.unitPrice,
          gross: quotationLines.gross,
        })
        .from(quotationLines)
        .where(
          and(
            eq(quotationLines.tenantId, c.tenantId),
            eq(quotationLines.organizationId, c.organizationId),
            eq(quotationLines.versionId, c.versionId),
          ),
        )
        .orderBy(asc(quotationLines.lineNo));
      const taxSummary = await tx
        .select({
          label: quotationTaxSummary.label,
          rate: quotationTaxSummary.rate,
          base: quotationTaxSummary.base,
          tax: quotationTaxSummary.tax,
        })
        .from(quotationTaxSummary)
        .where(
          and(
            eq(quotationTaxSummary.tenantId, c.tenantId),
            eq(quotationTaxSummary.organizationId, c.organizationId),
            eq(quotationTaxSummary.versionId, c.versionId),
          ),
        );

      const [issuer] = await tx
        .select({ legalName: organizations.legalName })
        .from(organizations)
        .where(and(eq(organizations.tenantId, c.tenantId), eq(organizations.id, c.organizationId)))
        .limit(1);
      if (issuer === undefined) return undefined;

      return {
        version,
        quotation: { number: quotation.number },
        customer,
        contact,
        paymentTerm,
        lines,
        taxSummary,
        issuerLegalName: issuer.legalName,
      };
    },

    async markRendered(tx, c, rendered, now) {
      const rows = await tx
        .update(quotationVersions)
        .set({
          renderedDocumentId: rendered.documentId,
          renderedSha256: rendered.sha256,
          renderState: 'rendered',
          updatedAt: now,
        })
        .where(and(ownVersion(c), eq(quotationVersions.renderState, 'pending')))
        .returning({ id: quotationVersions.id });
      // Not pending any more: another worker took over a stale claim. Say so instead of claiming success.
      if (rows.length !== 1) throw new Error('render claim was lost');
    },

    async markFailed(tx, c, now) {
      await tx
        .update(quotationVersions)
        .set({ renderState: 'failed', updatedAt: now })
        .where(and(ownVersion(c), eq(quotationVersions.renderState, 'pending')));
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
            eq(documents.ownerType, QUOTATION_OWNER_TYPE),
            isNull(documents.removedAt),
            lt(documents.createdAt, cutoff),
            eq(documentVersions.status, 'awaiting_content'),
          ),
        )
        .orderBy(asc(documents.createdAt))
        .limit(limit);
    },

    async removeOrphan(tx, o, now) {
      // Soft remove, like DocumentsService.remove (which refuses here: the version is approved). Rows are kept
      // for the audit trail, and there are no bytes to delete: the version never left awaiting_content.
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

@Processor(QUOTATION_RENDER_QUEUE)
export class QuotationRenderProcessor extends WorkerHost {
  constructor(private readonly sweeper: QuotationRenderSweeper) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === QUOTATION_RENDER_SWEEP_JOB) {
      await this.sweeper.sweep();
      return;
    }
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    throw new Error(`Unknown quotation render job: ${job.name}`);
  }
}

/** Registers the one-minute sweep. upsertJobScheduler is idempotent, so restarts never stack schedules. */
@Injectable()
export class QuotationRenderScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(QUOTATION_RENDER_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      QUOTATION_RENDER_SWEEP_JOB,
      { every: SWEEP_EVERY_MS },
      { name: QUOTATION_RENDER_SWEEP_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
