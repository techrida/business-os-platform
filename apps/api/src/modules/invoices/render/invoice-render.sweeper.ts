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
//   written only after the bytes were accepted, so a crash never leaves a print behind that no one received. Print 1
//   also keeps the number grouping and date pattern it was printed with (`render_format`), so a copy printed after
//   the settings changed still looks like the original. A copy of a print made before 0051 (no stored format) uses
//   the settings in force when the copy is printed.
//   Print 1 also freezes the company logo's bytes into that format (U12, see frozen-logo.ts), so a copy printed after
//   the logo changed or was removed still shows the original's logo. A copy of a print made before logos were frozen
//   prints without one, and a copy never resolves the logo. The seller's phones, email and signatory are frozen the
//   same way (U16-Q4, see invoice-html.ts).
//
// Claiming: the slow part (Chromium) runs with no transaction and no lock. The write is then serialised per invoice by
// a transaction advisory lock and a re-check for a live document, so two workers that raced both render but only one
// stores a file; the other answers `skipped`.
//
// Failures (round 4, R4c2; render-retry.ts, render-failures.ts): a failed render is recorded in
// `document_render_failures` and tried again after a pause that grows, until the tries run out. Then the render is
// given up, one admin (audit) entry `invoice.pdf_render_failed` is written in the same transaction, the candidate
// query leaves the invoice alone, and the download answers 424 so staff see the error and a Retry (the Retry route
// deletes the row). A success deletes the row. A rotating cursor keeps the oldest invoices from filling every batch; a
// restart forgets only the cursor. A document created by a render that failed before its bytes were stored is removed
// in the same failure path, so the next try is not blocked by it; one left by a crash between the two steps is
// soft-removed after ORPHAN_AFTER_MS, which makes its invoice a candidate again.
//
// The tests drive the sweeper through a RenderStore fake; the drizzle store below is checked by the integration test.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  DocumentFormatSnapshotSchema,
  documentSellerContact,
  SETTINGS,
  type DocumentFormatSnapshot,
} from '@bos/contracts';
import {
  documents,
  invoiceLines,
  invoicePrintLog,
  invoices,
  invoiceTaxSummary,
  scoped,
} from '@bos/db';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, isNull, lt, not, notExists, sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, type TxScope } from '../../../platform/db/tx';
import { GotenbergError } from '../../quotations/render/gotenberg.client';
import { DocumentLogoUnavailableError } from '../../quotations/render/issuer';
import type {
  Clock,
  PdfRenderer,
  RenderDocuments,
  RenderAudit,
  RenderLogos,
  RenderSettings,
  RunInTx,
} from '../../quotations/render/quotation-render.sweeper';
import {
  GENERATED_ORPHAN_AFTER_MS,
  RENDER_GIVEN_UP_ACTION,
} from '../../quotations/render/render-retry';
import { INVOICE_OWNER_TYPE, INVOICE_RENDER_JOB_PREFIX } from '../invoice-owner.policy';
import { freezeEntityLogo } from './frozen-logo';
import { renderInvoiceHtml } from './invoice-html';
import {
  clearRenderFailure,
  discardUnfilledDocument,
  filledVersion,
  recordRenderFailure,
  renderHeldBack,
  type RecordedFailure,
  type RenderFailureOwner,
} from './render-failures';
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
/** A generated document still without its bytes after this long was left by a render that crashed midway. */
export const ORPHAN_AFTER_MS = GENERATED_ORPHAN_AFTER_MS;
/** Invoices handled per tick; the rest wait a minute. Keeps one tick bounded (each render has its own deadline). */
const BATCH = 10;
const ORPHAN_BATCH = 50;

export const INVOICE_RENDER_STORE = Symbol('INVOICE_RENDER_STORE');
export const INVOICE_RENDER_TX = Symbol('INVOICE_RENDER_TX');
export const INVOICE_RENDER_DOCUMENTS = Symbol('INVOICE_RENDER_DOCUMENTS');
export const INVOICE_RENDER_SETTINGS = Symbol('INVOICE_RENDER_SETTINGS');
export const INVOICE_RENDER_PDF = Symbol('INVOICE_RENDER_PDF');
export const INVOICE_RENDER_CLOCK = Symbol('INVOICE_RENDER_CLOCK');
/** DocumentLogoResolverFactory in the worker: turns the profile's logo document into the bytes print 1 freezes. */
export const INVOICE_RENDER_LOGOS = Symbol('INVOICE_RENDER_LOGOS');
/** AuditService in the worker: writes the admin entry when a render is given up. */
export const INVOICE_RENDER_AUDIT = Symbol('INVOICE_RENDER_AUDIT');

export interface RenderCandidate {
  tenantId: string;
  organizationId: string;
  invoiceId: string;
}

/**
 * What the mapper needs of an invoice's rows, the number this print will take in the print log, and print 1's stored
 * `render_format` as it is in the row (unvalidated; null when there is no print 1 yet or it predates 0051).
 */
export type RenderSource = Omit<InvoiceViewInput, 'printNo'> & {
  nextPrintNo: number;
  originalFormat: unknown;
};

export interface OrphanDocument {
  tenantId: string;
  organizationId: string;
  documentId: string;
}

/** The sweeper's database access, as a port. `tx` is the transaction `INVOICE_RENDER_TX` opened for the invoice's scope. */
export interface RenderStore {
  /**
   * Issued invoices with no live document that may be tried at `now` (not waiting out a failure's pause, not given
   * up), oldest first after `after`, wrapping when exhausted.
   */
  candidates(now: Date, limit: number, after?: string): Promise<RenderCandidate[]>;
  load(tx: DbTransaction, c: RenderCandidate): Promise<RenderSource | undefined>;
  /**
   * Takes this invoice's render lock for the rest of `tx` and answers whether it already has a live document. The lock
   * is what makes the answer stay true until the caller commits.
   */
  lockAndHasDocument(tx: DbTransaction, c: RenderCandidate): Promise<boolean>;
  /**
   * Appends the print to the log; a print number that is already there is left as it is. `format` is what the print
   * used; the sweeper passes it for print 1 only (null for a copy), and it is stored as `render_format`.
   */
  recordPrint(
    tx: DbTransaction,
    c: RenderCandidate,
    printNo: number,
    now: Date,
    format: DocumentFormatSnapshot | null,
  ): Promise<void>;
  orphans(cutoff: Date, limit: number): Promise<OrphanDocument[]>;
  removeOrphan(tx: DbTransaction, o: OrphanDocument, now: Date): Promise<void>;
  /**
   * Soft-removes the invoice's document `documentId` when none of its versions got bytes (still awaiting_content):
   * the render that created it failed before storing them. A document that got its bytes is left alone.
   */
  discardUnfilled(
    tx: DbTransaction,
    c: RenderCandidate,
    documentId: string,
    now: Date,
  ): Promise<void>;
  /**
   * Soft-removes the invoice's document `documentId` although it got its bytes: its print could not be recorded, so it
   * is not print 1 yet. Only the failure path of the try that created it calls this.
   */
  discardUnprinted(
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
  /** Forgets the invoice's failures after a success. */
  clearFailure(tx: DbTransaction, c: RenderCandidate): Promise<void>;
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
  if (
    error instanceof InvoiceNotRenderableError ||
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
export class InvoiceRenderSweeper {
  private readonly logger = new Logger(InvoiceRenderSweeper.name);
  /** The last attempted row's immutable position; one cursor rather than an unbounded attempt history. */
  private after: string | undefined;

  constructor(
    @Inject(INVOICE_RENDER_STORE) private readonly store: RenderStore,
    @Inject(INVOICE_RENDER_TX) private readonly runTx: RunInTx,
    @Inject(INVOICE_RENDER_DOCUMENTS) private readonly documents: RenderDocuments,
    @Inject(INVOICE_RENDER_SETTINGS) private readonly settings: RenderSettings,
    @Inject(INVOICE_RENDER_PDF) private readonly pdf: PdfRenderer,
    @Inject(INVOICE_RENDER_CLOCK) private readonly clock: Clock,
    @Inject(INVOICE_RENDER_LOGOS) private readonly logos: RenderLogos,
    @Inject(INVOICE_RENDER_AUDIT) private readonly audit: RenderAudit,
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

  /** One invoice: its outcome and, for a failure, the kind that was logged. */
  private async attempt(c: RenderCandidate): Promise<{ outcome: RenderOutcome; kind?: string }> {
    const scope: TxScope = { tenantId: c.tenantId, organizationId: c.organizationId };
    const actor = systemActor(INVOICE_RENDER_JOB_PREFIX);
    /** The document this try created, if it got that far: a failure after it must not leave it blocking the next. */
    let created: { documentId: string } | undefined;
    /** Whether its bytes were stored: then only the print row is missing, and the document goes even with its bytes. */
    let received = false;
    try {
      const source = await this.runTx(scope, actor, (tx) => this.store.load(tx, c));
      if (source === undefined) throw new RenderSourceMissingError();
      const { nextPrintNo, originalFormat, ...rows } = source;
      const view = toInvoiceRenderView({ ...rows, printNo: nextPrintNo });
      const format = await this.formatFor(scope, nextPrintNo, originalFormat);
      const bytes = await this.pdf.htmlToPdf(
        renderInvoiceHtml(view, {
          numberSystems: format.numberSystems,
          dateFormat: format.dateFormat,
          logoDataUrl: format.logoDataUrl ?? null,
          sellerContact: format.sellerContact ?? null,
        }),
      );
      const file = {
        filename: invoicePdfFilename(rows.invoice.number ?? c.invoiceId, view.copyNo),
        declaredMime: 'application/pdf',
        bytes,
      };

      // The lock and the re-check make "no live document yet" true until this commits, so only one racer stores.
      const generated = await this.runTx(scope, actor, async (tx) =>
        (await this.store.lockAndHasDocument(tx, c))
          ? undefined
          : this.documents.createGenerated(
              tx,
              { ownerType: INVOICE_OWNER_TYPE, ownerId: c.invoiceId },
              file,
            ),
      );
      if (generated === undefined) return { outcome: 'skipped' };
      created = generated;
      // After the commit above: the content step opens its own transactions and the scan worker reads the row.
      await this.documents.receiveGenerated(generated, file, { scope, actor });
      received = true;

      // The bytes are in and queued for the scan: now the print is real, and earlier failures are forgotten. If this
      // fails, the document is removed with the failure: a PDF without its print row would keep print 1's format
      // unsaved for good (its invoice is never a candidate again), so the next try renders print 1 again.
      await this.runTx(scope, actor, async (tx) => {
        await this.store.recordPrint(
          tx,
          c,
          nextPrintNo,
          this.clock(),
          nextPrintNo === 1 ? format : null,
        );
        await this.store.clearFailure(tx, c);
      });
      return { outcome: 'rendered' };
    } catch (error) {
      const kind = failureKind(error);
      this.logger.warn(`invoice render failed: invoice=${c.invoiceId} kind=${kind}`);
      await this.noteFailure(c, scope, kind, created, received);
      return { outcome: 'failed', kind };
    }
  }

  /**
   * Records a failed try. First, in its own transaction, removes the document this try created: if it never got its
   * bytes, or if it got them but its print was not recorded (`received`). Then, in another, counts the failure and,
   * when that used up the last try, writes the admin entry. Apart, so that one failing does not undo the other: a
   * document left live would keep the invoice out of the candidates until the orphan cleanup. A failure of either is
   * logged and left to the next sweep (an unfilled document left behind is removed as an orphan).
   */
  private async noteFailure(
    c: RenderCandidate,
    scope: TxScope,
    kind: string,
    created: { documentId: string } | undefined,
    received: boolean,
  ): Promise<void> {
    const actor = systemActor(INVOICE_RENDER_JOB_PREFIX);
    if (created !== undefined) {
      try {
        await this.runTx(scope, actor, (tx) =>
          received
            ? this.store.discardUnprinted(tx, c, created.documentId, this.clock())
            : this.store.discardUnfilled(tx, c, created.documentId, this.clock()),
        );
      } catch (error) {
        this.logger.error(
          `invoice render: could not remove the failed try's document: invoice=${c.invoiceId} kind=${failureKind(error)}`,
        );
      }
    }
    try {
      await this.runTx(scope, actor, async (tx) => {
        const now = this.clock();
        const recorded = await this.store.recordFailure(tx, c, kind, now);
        if (!recorded.givenUp) return;
        await this.audit.record(tx, {
          action: RENDER_GIVEN_UP_ACTION.invoice,
          entityType: 'invoices',
          entityId: c.invoiceId,
          after: { attempts: recorded.attempts, failureKind: kind },
        });
        this.logger.error(
          `invoice render given up: invoice=${c.invoiceId} attempts=${recorded.attempts} kind=${kind}`,
        );
      });
    } catch (error) {
      this.logger.error(
        `invoice render: could not record the failure: invoice=${c.invoiceId} kind=${failureKind(error)}`,
      );
    }
  }

  /**
   * The grouping, date pattern and logo this print uses. A copy reuses what print 1 stored; print 1, or a copy of a
   * print made before 0051 (or one whose stored value no longer parses), reads the settings in force now. An invalid
   * setting (a hand-edited row) prints the default; it never fails the render. Only print 1 resolves the logo and the
   * seller contact: a copy without a usable stored format prints neither, as its original did.
   */
  private async formatFor(
    scope: TxScope,
    printNo: number,
    originalFormat: unknown,
  ): Promise<DocumentFormatSnapshot> {
    if (printNo > 1) {
      const stored = DocumentFormatSnapshotSchema.safeParse(originalFormat);
      if (stored.success) return stored.data;
    }
    const numberSystems = SETTINGS['format.number_systems'].safeParse(
      await this.settings.get(scope, 'format.number_systems'),
    );
    const dateFormat = SETTINGS['format.date'].safeParse(
      await this.settings.get(scope, 'format.date'),
    );
    return {
      numberSystems: numberSystems.success ? numberSystems.data : DEFAULT_NUMBER_SYSTEMS,
      dateFormat: dateFormat.success ? dateFormat.data : DEFAULT_DATE_FORMAT,
      logoDataUrl: printNo === 1 ? await freezeEntityLogo(this.settings, this.logos, scope) : null,
      // The phones, email and signatory, frozen like the logo: only print 1 reads the profile (U16-Q4).
      sellerContact:
        printNo === 1
          ? documentSellerContact(await this.settings.get(scope, 'entity.profile'))
          : null,
      capturedAt: this.clock().toISOString(),
    };
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

const ownerOf = (c: RenderCandidate): RenderFailureOwner => ({
  tenantId: c.tenantId,
  organizationId: c.organizationId,
  ownerType: INVOICE_OWNER_TYPE,
  ownerId: c.invoiceId,
});

/** The store on the real tables. Every query names the tenant and the acting entity. */
export function drizzleInvoiceRenderStore(db: Db): RenderStore {
  return {
    async candidates(now, limit, after) {
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
              not(
                renderHeldBack(
                  db,
                  INVOICE_OWNER_TYPE,
                  {
                    tenantId: invoices.tenantId,
                    organizationId: invoices.organizationId,
                    id: invoices.id,
                  },
                  now,
                ),
              ),
              cursor === undefined
                ? undefined
                : sql`(${invoices.issuedAt}, ${invoices.id}) >
                    (SELECT issued_at, id FROM ${invoices} WHERE id = ${cursor})`,
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

      // Print 1 is the original: a copy prints with the format it stored.
      const [original] = await tx
        .select({ renderFormat: invoicePrintLog.renderFormat })
        .from(invoicePrintLog)
        .where(
          s.where(
            invoicePrintLog,
            and(eq(invoicePrintLog.invoiceId, c.invoiceId), eq(invoicePrintLog.printNo, 1)),
          ),
        )
        .limit(1);

      return {
        invoice,
        lines,
        taxSummary,
        nextPrintNo: (last?.printNo ?? 0) + 1,
        originalFormat: original?.renderFormat ?? null,
      };
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

    async recordPrint(tx, c, printNo, now, format) {
      await tx
        .insert(invoicePrintLog)
        .values(
          scoped({ tenantId: c.tenantId, organizationId: c.organizationId }).values({
            invoiceId: c.invoiceId,
            printNo,
            // A background render has no person behind it.
            printedBy: null,
            printedAt: now,
            renderFormat: format,
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
        .where(
          and(
            eq(documents.ownerType, INVOICE_OWNER_TYPE),
            isNull(documents.removedAt),
            lt(documents.createdAt, cutoff),
            notExists(filledVersion(db, documents.tenantId, documents.id)),
          ),
        )
        .orderBy(asc(documents.createdAt))
        .limit(limit);
    },

    discardUnfilled(tx, c, documentId, now) {
      return discardUnfilledDocument(tx, ownerOf(c), documentId, now);
    },

    async discardUnprinted(tx, c, documentId, now) {
      await tx
        .update(documents)
        .set({ removedAt: now, updatedAt: now })
        .where(
          and(
            eq(documents.tenantId, c.tenantId),
            eq(documents.organizationId, c.organizationId),
            eq(documents.ownerType, INVOICE_OWNER_TYPE),
            eq(documents.ownerId, c.invoiceId),
            eq(documents.id, documentId),
            isNull(documents.removedAt),
          ),
        );
    },

    recordFailure(tx, c, kind, now) {
      return recordRenderFailure(tx, ownerOf(c), kind, now);
    },

    clearFailure(tx, c) {
      return clearRenderFailure(tx, ownerOf(c));
    },

    async removeOrphan(tx, o, now) {
      // Soft remove, like DocumentsService.remove (which refuses here: nobody removes an invoice file by hand). Rows
      // are kept for the audit trail, and there are no bytes to delete: the version is awaiting_content or rejected.
      await tx
        .update(documents)
        .set({ removedAt: now, updatedAt: now })
        .where(
          and(
            eq(documents.tenantId, o.tenantId),
            eq(documents.organizationId, o.organizationId),
            eq(documents.id, o.documentId),
            isNull(documents.removedAt),
            // Re-checked here: the bytes may have landed between the listing and this update.
            notExists(filledVersion(tx, documents.tenantId, documents.id)),
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
