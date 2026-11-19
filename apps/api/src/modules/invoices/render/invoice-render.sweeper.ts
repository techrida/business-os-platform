// The invoice render sweeper (worker only; P3 unit U11): every minute it finds issued tax invoices, proformas, credit
// notes and debit notes that have no PDF yet, renders each one (frozen row -> whitelist view -> HTML -> Gotenberg -> PDF), stores the PDF as
// a generated document of the invoice and appends the print to `invoice_print_log`. It never runs inside the issue
// transaction, so a slow or broken renderer cannot hold up or fail an issue.
//
// Why a sweeper and not an event: an issued invoice row is frozen (invoices_guard), so there is no render_state column
// to claim, and the outbox table is email-only. The whole state of a render lives in two places that may grow:
// - `documents` (owner type `invoice`): a live document means "rendered, or being rendered". An invoice is a candidate
//   exactly when it has none. The document goes in through the documents module's generated-file path under the actor
//   `system:invoice-render`, which InvoiceOwnerPolicy allows only for an issued invoice.
// - `invoice_print_log` (append-only): print 1 is the original; a later print renders "Copy of original (n)". It is
//   written only after the bytes were accepted, so a crash never leaves a print behind that no one received.
//
// Claiming: the slow part (Chromium) runs with no transaction and no lock. The write is then serialised per invoice by
// a transaction advisory lock and a re-check for a live document, so two workers that raced both render but only one
// stores a file; the other answers `skipped`. Failure backoff has no durable home (no column, and the log is for
// prints), so a failed invoice is remembered in this process for FAILED_RETRY_MS and left out of the candidate query.
// A rotating cursor keeps expired failures from filling every batch; a restart forgets both backoff and cursor. A
// document that never got its bytes (a crash between the two steps) is soft-removed after ORPHAN_AFTER_MS, which makes
// its invoice a candidate again.
//
// The tests drive the sweeper through a RenderStore fake; the drizzle store below is checked by the integration test.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { SETTINGS } from '@bos/contracts';
import {
  documents,
  documentVersions,
  invoiceLines,
  invoicePrintLog,
  invoices,
  invoiceTaxSummary,
  scoped,
} from '@bos/db';
import { DEFAULT_NUMBER_SYSTEM } from '@bos/locale';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, isNull, lt, notExists, notInArray, sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, type TxScope } from '../../../platform/db/tx';
import { GotenbergError } from '../../quotations/render/gotenberg.client';
import type {
  Clock,
  PdfRenderer,
  RenderDocuments,
  RenderSettings,
  RunInTx,
} from '../../quotations/render/quotation-render.sweeper';
import { INVOICE_OWNER_TYPE, INVOICE_RENDER_JOB_PREFIX } from '../invoice-owner.policy';
import { renderInvoiceHtml } from './invoice-html';
import {
  InvoiceNotRenderableError,
  invoicePdfFilename,
  RENDERABLE_INVOICE_KINDS,
  toInvoiceRenderView,
  type InvoiceViewInput,
} from './invoice-view';

export const INVOICE_RENDER_QUEUE = 'invoice.render';
export const INVOICE_RENDER_SWEEP_JOB = 'invoice.render.sweep';
export const SWEEP_EVERY_MS = 60_000;
/** A failed invoice is left alone this long (in this process), so a permanent fault does not hammer Gotenberg. */
export const FAILED_RETRY_MS = 5 * 60_000;
/** A generated document still awaiting its bytes after this long was left by a render that crashed midway. */
export const ORPHAN_AFTER_MS = 60 * 60_000;
/** Invoices handled per tick; the rest wait a minute. Keeps one tick bounded (each render has its own deadline). */
const BATCH = 10;
const ORPHAN_BATCH = 50;

export const INVOICE_RENDER_STORE = Symbol('INVOICE_RENDER_STORE');
export const INVOICE_RENDER_TX = Symbol('INVOICE_RENDER_TX');
export const INVOICE_RENDER_DOCUMENTS = Symbol('INVOICE_RENDER_DOCUMENTS');
export const INVOICE_RENDER_SETTINGS = Symbol('INVOICE_RENDER_SETTINGS');
export const INVOICE_RENDER_PDF = Symbol('INVOICE_RENDER_PDF');
export const INVOICE_RENDER_CLOCK = Symbol('INVOICE_RENDER_CLOCK');

export interface RenderCandidate {
  tenantId: string;
  organizationId: string;
  invoiceId: string;
}

/** What the mapper needs of an invoice's rows, and the number this print will take in the print log. */
export type RenderSource = Omit<InvoiceViewInput, 'printNo'> & { nextPrintNo: number };

export interface OrphanDocument {
  tenantId: string;
  organizationId: string;
  documentId: string;
}

/** The sweeper's database access, as a port. `tx` is the transaction `INVOICE_RENDER_TX` opened for the invoice's scope. */
export interface RenderStore {
  /** Issued invoices with no live document, oldest first after `after`, wrapping when exhausted, except `exclude`. */
  candidates(limit: number, exclude: readonly string[], after?: string): Promise<RenderCandidate[]>;
  load(tx: DbTransaction, c: RenderCandidate): Promise<RenderSource | undefined>;
  /**
   * Takes this invoice's render lock for the rest of `tx` and answers whether it already has a live document. The lock
   * is what makes the answer stay true until the caller commits.
   */
  lockAndHasDocument(tx: DbTransaction, c: RenderCandidate): Promise<boolean>;
  /** Appends the print to the log; a print number that is already there is left as it is. */
  recordPrint(tx: DbTransaction, c: RenderCandidate, printNo: number, now: Date): Promise<void>;
  orphans(cutoff: Date, limit: number): Promise<OrphanDocument[]>;
  removeOrphan(tx: DbTransaction, o: OrphanDocument, now: Date): Promise<void>;
}

export type RenderOutcome = 'rendered' | 'failed' | 'skipped';
export interface RenderFailure {
  invoiceId: string;
  /** The fixed word the log line carries (failureKind), never a message. */
  kind: string;
}
export interface SweepResult {
  rendered: number;
  failed: number;
  skipped: number;
  orphansRemoved: number;
  /** Each invoice that failed in this pass, so a caller (a test, an admin tool) can say why without the log. */
  failures: RenderFailure[];
}

/** The invoice's rows are gone or incomplete (for example no customer), so there is nothing to render. */
export class RenderSourceMissingError extends Error {
  readonly kind = 'source_missing';
  constructor() {
    super('The invoice has no renderable rows');
    this.name = 'RenderSourceMissingError';
  }
}

/** A fixed word for the log: a kind, never a message (messages can carry URLs or customer data). */
export function failureKind(error: unknown): string {
  if (error instanceof GotenbergError) return `gotenberg_${error.kind}`;
  if (error instanceof InvoiceNotRenderableError || error instanceof RenderSourceMissingError) {
    return error.kind;
  }
  // A Nest service on the way refused (the documents module answers 400, 403 or 404): its status, not its text.
  if (error instanceof HttpException) return `http_${error.getStatus()}`;
  return 'error';
}

@Injectable()
export class InvoiceRenderSweeper {
  private readonly logger = new Logger(InvoiceRenderSweeper.name);
  /** invoice id -> when it last failed. In memory on purpose: see the file header. */
  private readonly failedAt = new Map<string, number>();
  /** The last attempted row's immutable position; one cursor rather than an unbounded attempt history. */
  private after: string | undefined;

  constructor(
    @Inject(INVOICE_RENDER_STORE) private readonly store: RenderStore,
    @Inject(INVOICE_RENDER_TX) private readonly runTx: RunInTx,
    @Inject(INVOICE_RENDER_DOCUMENTS) private readonly documents: RenderDocuments,
    @Inject(INVOICE_RENDER_SETTINGS) private readonly settings: RenderSettings,
    @Inject(INVOICE_RENDER_PDF) private readonly pdf: PdfRenderer,
    @Inject(INVOICE_RENDER_CLOCK) private readonly clock: Clock,
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
    const candidates = await this.store.candidates(BATCH, this.backedOff(), this.after);
    // One at a time: Chromium is the scarce resource, and an invoice's failure must not touch the next one.
    for (const c of candidates) {
      const { outcome, kind } = await this.attempt(c);
      this.after = c.invoiceId;
      result[outcome] += 1;
      if (kind !== undefined) result.failures.push({ invoiceId: c.invoiceId, kind });
    }
    result.orphansRemoved = await this.removeOrphans();
    return result;
  }

  async renderOne(c: RenderCandidate): Promise<RenderOutcome> {
    return (await this.attempt(c)).outcome;
  }

  /** The invoices that failed less than FAILED_RETRY_MS ago. Older entries are forgotten here. */
  private backedOff(): string[] {
    const cutoff = this.clock().getTime() - FAILED_RETRY_MS;
    for (const [id, at] of this.failedAt) if (at <= cutoff) this.failedAt.delete(id);
    return [...this.failedAt.keys()];
  }

  /** One invoice: its outcome and, for a failure, the kind that was logged. */
  private async attempt(c: RenderCandidate): Promise<{ outcome: RenderOutcome; kind?: string }> {
    const scope: TxScope = { tenantId: c.tenantId, organizationId: c.organizationId };
    const actor = systemActor(INVOICE_RENDER_JOB_PREFIX);
    try {
      const source = await this.runTx(scope, actor, (tx) => this.store.load(tx, c));
      if (source === undefined) throw new RenderSourceMissingError();
      const { nextPrintNo, ...rows } = source;
      const view = toInvoiceRenderView({ ...rows, printNo: nextPrintNo });
      // The setting is read at render time, as the document is first stored. An invalid value (a hand-edited row)
      // prints the default grouping; it never fails the render.
      const numberSystem = SETTINGS['format.number_system'].safeParse(
        await this.settings.get(scope, 'format.number_system'),
      );
      const bytes = await this.pdf.htmlToPdf(
        renderInvoiceHtml(view, {
          numberSystem: numberSystem.success ? numberSystem.data : DEFAULT_NUMBER_SYSTEM,
        }),
      );
      const file = {
        filename: invoicePdfFilename(rows.invoice.number ?? c.invoiceId, view.copyNo),
        declaredMime: 'application/pdf',
        bytes,
      };

      // The lock and the re-check make "no live document yet" true until this commits, so only one racer stores.
      const created = await this.runTx(scope, actor, async (tx) =>
        (await this.store.lockAndHasDocument(tx, c))
          ? undefined
          : this.documents.createGenerated(
              tx,
              { ownerType: INVOICE_OWNER_TYPE, ownerId: c.invoiceId },
              file,
            ),
      );
      if (created === undefined) return { outcome: 'skipped' };
      // After the commit above: the content step opens its own transactions and the scan worker reads the row.
      await this.documents.receiveGenerated(created, file, { scope, actor });

      // The bytes are in and queued for the scan: now the print is real.
      await this.runTx(scope, actor, (tx) =>
        this.store.recordPrint(tx, c, nextPrintNo, this.clock()),
      );
      this.failedAt.delete(c.invoiceId);
      return { outcome: 'rendered' };
    } catch (error) {
      const kind = failureKind(error);
      this.failedAt.set(c.invoiceId, this.clock().getTime());
      this.logger.warn(`invoice render failed: invoice=${c.invoiceId} kind=${kind}`);
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
        await this.runTx(scope, systemActor(INVOICE_RENDER_JOB_PREFIX), (tx) =>
          this.store.removeOrphan(tx, o, now),
        );
        removed += 1;
      } catch (error) {
        this.logger.error(
          `invoice render: could not remove an orphan document: document=${o.documentId} kind=${failureKind(error)}`,
        );
      }
    }
    return removed;
  }
}

/** The store on the real tables. Every query names the tenant and the acting entity. */
export function drizzleInvoiceRenderStore(db: Db): RenderStore {
  return {
    async candidates(limit, exclude, after) {
      const hasLiveDocument = db
        .select({ one: sql`1` })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, invoices.tenantId),
            eq(documents.organizationId, invoices.organizationId),
            eq(documents.ownerType, INVOICE_OWNER_TYPE),
            eq(documents.ownerId, invoices.id),
            isNull(documents.removedAt),
          ),
        );
      const page = (cursor?: string) =>
        db
          .select({
            tenantId: invoices.tenantId,
            organizationId: invoices.organizationId,
            invoiceId: invoices.id,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.status, 'issued'),
              inArray(invoices.kind, [...RENDERABLE_INVOICE_KINDS]),
              notExists(hasLiveDocument),
              cursor === undefined
                ? undefined
                : sql`(${invoices.issuedAt}, ${invoices.id}) >
                    (SELECT issued_at, id FROM ${invoices} WHERE id = ${cursor})`,
              exclude.length === 0 ? undefined : notInArray(invoices.id, [...exclude]),
            ),
          )
          .orderBy(asc(invoices.issuedAt), asc(invoices.id))
          .limit(limit);
      // Read the cursor row independently of document eligibility. A rendered or removed cursor still advances;
      // a missing cursor yields an empty page and safely restarts from the beginning.
      const next = await page(after);
      return next.length > 0 || after === undefined ? next : page();
    },

    async load(tx, c) {
      const s = scoped({ tenantId: c.tenantId, organizationId: c.organizationId });
      const [invoice] = await tx
        .select({
          kind: invoices.kind,
          status: invoices.status,
          number: invoices.number,
          issueDate: invoices.issueDate,
          issueDateBs: invoices.issueDateBs,
          dueDate: invoices.dueDate,
          currency: invoices.currency,
          subtotal: invoices.subtotal,
          discountAmount: invoices.discountAmount,
          taxableVatAmount: invoices.taxableVatAmount,
          exemptAmount: invoices.exemptAmount,
          zeroRatedAmount: invoices.zeroRatedAmount,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          sellerSnapshot: invoices.sellerSnapshot,
          buyerSnapshot: invoices.buyerSnapshot,
        })
        .from(invoices)
        .where(s.where(invoices, eq(invoices.id, c.invoiceId)))
        .limit(1);
      if (invoice === undefined) return undefined;

      const lines = await tx
        .select({
          lineNo: invoiceLines.lineNo,
          description: invoiceLines.description,
          uom: invoiceLines.uom,
          quantity: invoiceLines.quantity,
          unitPrice: invoiceLines.unitPrice,
          gross: invoiceLines.gross,
        })
        .from(invoiceLines)
        .where(s.where(invoiceLines, eq(invoiceLines.invoiceId, c.invoiceId)))
        .orderBy(asc(invoiceLines.lineNo));
      const taxSummary = await tx
        .select({
          label: invoiceTaxSummary.label,
          rate: invoiceTaxSummary.rate,
          base: invoiceTaxSummary.base,
          tax: invoiceTaxSummary.tax,
        })
        .from(invoiceTaxSummary)
        .where(s.where(invoiceTaxSummary, eq(invoiceTaxSummary.invoiceId, c.invoiceId)))
        .orderBy(asc(invoiceTaxSummary.label));
      const [last] = await tx
        .select({ printNo: invoicePrintLog.printNo })
        .from(invoicePrintLog)
        .where(s.where(invoicePrintLog, eq(invoicePrintLog.invoiceId, c.invoiceId)))
        .orderBy(desc(invoicePrintLog.printNo))
        .limit(1);

      return { invoice, lines, taxSummary, nextPrintNo: (last?.printNo ?? 0) + 1 };
    },

    async lockAndHasDocument(tx, c) {
      // Two renders of one invoice queue here; the second then sees the first one's document.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`invoice-render:${c.invoiceId}`}))`,
      );
      const [found] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          scoped({ tenantId: c.tenantId, organizationId: c.organizationId }).where(
            documents,
            and(
              eq(documents.ownerType, INVOICE_OWNER_TYPE),
              eq(documents.ownerId, c.invoiceId),
              isNull(documents.removedAt),
            ),
          ),
        )
        .limit(1);
      return found !== undefined;
    },

    async recordPrint(tx, c, printNo, now) {
      await tx
        .insert(invoicePrintLog)
        .values(
          scoped({ tenantId: c.tenantId, organizationId: c.organizationId }).values({
            invoiceId: c.invoiceId,
            printNo,
            // A background render has no person behind it.
            printedBy: null,
            printedAt: now,
          }),
        )
        .onConflictDoNothing();
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
            eq(documents.ownerType, INVOICE_OWNER_TYPE),
            isNull(documents.removedAt),
            lt(documents.createdAt, cutoff),
            eq(documentVersions.status, 'awaiting_content'),
          ),
        )
        .orderBy(asc(documents.createdAt))
        .limit(limit);
    },

    async removeOrphan(tx, o, now) {
      // Soft remove, like DocumentsService.remove (which refuses here: nobody removes an invoice file by hand). Rows
      // are kept for the audit trail, and there are no bytes to delete: the version never left awaiting_content.
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

@Processor(INVOICE_RENDER_QUEUE)
export class InvoiceRenderProcessor extends WorkerHost {
  constructor(private readonly sweeper: InvoiceRenderSweeper) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === INVOICE_RENDER_SWEEP_JOB) {
      await this.sweeper.sweep();
      return;
    }
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    throw new Error(`Unknown invoice render job: ${job.name}`);
  }
}

/** Registers the one-minute sweep. upsertJobScheduler is idempotent, so restarts never stack schedules. */
@Injectable()
export class InvoiceRenderScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(INVOICE_RENDER_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      INVOICE_RENDER_SWEEP_JOB,
      { every: SWEEP_EVERY_MS },
      { name: INVOICE_RENDER_SWEEP_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
