// The quotation render sweeper (worker only): every minute it finds approved quotation versions that have no PDF
// yet, renders each one (customer view -> HTML -> Gotenberg -> PDF), stores the PDF as a generated document of
// the version, and records it on the version. It never runs inside the approval decision, so a slow or broken
// renderer cannot hold up or fail an approval (NFR "a render can never block a decision").
//
// Safe to repeat and to run on two workers at once: every version is first claimed with one conditional UPDATE
// (render_state -> 'pending'), and only the claimant renders. A claim older than 10 minutes counts as abandoned
// (the worker died mid-render): each sweep first records it as a failed try, exactly like a render that threw, so a
// version that kills its worker every time is given up at the limit instead of being taken again forever. A failed version (round 4, R4c2: TR-Q4, F1-Q13) is retried after a pause that
// grows with render_attempts, the failures since its last success or Retry (render-retry.ts). The failure that uses up
// the last try leaves the version `failed` at MAX_RENDER_ATTEMPTS, which the candidate query never takes again, and
// writes one admin (audit) entry `quotation.pdf_render_failed` in the same transaction; the download then answers 424
// and staff may Retry, which resets the attempts. A success resets them too. The file goes in through
// the documents module's generated-file path under the actor `system:quotation-render`, which the owner policy
// allows only for an approved version, so the PDF is of exactly the content that was approved.
//
// How the document looks (layout, colour, company profile, number system) is frozen with the version too: the
// first attempt captures it from settings and stores it on the version before rendering, and every later attempt
// (a retry after a failure) renders from the stored value, so a settings change never alters a document that was
// already issued and a retry never drifts. The company logo is frozen as its bytes (a data URL), read from the
// logo document the profile references, so changing or removing the logo later never alters a sent document.
//
// The tests drive the sweeper through a RenderStore fake; the drizzle store below is checked by the R3
// integration test against a real database.
import { createHash } from 'node:crypto';

import { defaultPortalDisplay, type DocumentStyleSnapshot } from '@bos/contracts';
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
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type { AuditRecordInput } from '../../../platform/audit/audit.service';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import {
  type Actor,
  READ_ONLY,
  systemActor,
  type TxOptions,
  type TxScope,
} from '../../../platform/db/tx';
import type { DocumentsService } from '../../../platform/documents/documents.service';
import type { SettingsService } from '../../../platform/settings/settings.service';
import { QUOTATION_OWNER_TYPE, QUOTATION_RENDER_JOB_PREFIX } from '../quotation-owner.policy';
import {
  quotationPdfFilename,
  toCustomerQuotationView,
  type CustomerViewInput,
} from './customer-view';
import { GotenbergError } from './gotenberg.client';
import {
  buildDocumentStyleSnapshot,
  buildIssuer,
  DocumentLogoUnavailableError,
  DocumentStyleInvalidError,
  type DocumentLogoResolver,
  IssuerIncompleteError,
  parseStoredDocumentStyle,
} from './issuer';
import { renderQuotationHtml } from './quotation-html';
import { QUOTATION_RENDER_ONE_JOB, QUOTATION_RENDER_QUEUE } from './quotation-render.nudge';
import { RenderOneJobSchema } from './render-nudge';
import { MAX_RENDER_ATTEMPTS, nextRetryPauseMs, RENDER_GIVEN_UP_ACTION } from './render-retry';

export { QUOTATION_RENDER_ONE_JOB, QUOTATION_RENDER_QUEUE } from './quotation-render.nudge';
export const QUOTATION_RENDER_SWEEP_JOB = 'quotation.render.sweep';
export const SWEEP_EVERY_MS = 60_000;
/** A version still `pending` after this long was claimed by a worker that died; that try counts as failed. */
export const PENDING_STALE_MS = 10 * 60_000;
/** A generated document still awaiting its bytes after this long was left by a render that crashed midway. */
export const ORPHAN_AFTER_MS = 60 * 60_000;
/** Versions handled per tick; the rest wait a minute. Keeps one tick bounded (each render has its own deadline). */
const BATCH = 10;
/** Abandoned claims recorded per tick. Cheap (one UPDATE each), so a larger batch than renders. */
const ABANDONED_BATCH = 50;
/** The kind a dead worker's try is logged and audited with: there is no error to name. */
export const ABANDONED_KIND = 'abandoned';
const ORPHAN_BATCH = 50;

export const RENDER_STORE = Symbol('QUOTATION_RENDER_STORE');
export const RENDER_TX = Symbol('QUOTATION_RENDER_TX');
export const RENDER_DOCUMENTS = Symbol('QUOTATION_RENDER_DOCUMENTS');
export const RENDER_SETTINGS = Symbol('QUOTATION_RENDER_SETTINGS');
export const RENDER_PDF = Symbol('QUOTATION_RENDER_PDF');
export const RENDER_CLOCK = Symbol('QUOTATION_RENDER_CLOCK');
export const RENDER_LOGOS = Symbol('QUOTATION_RENDER_LOGOS');
/** AuditService in the worker: writes the admin entry when a render is given up. */
export const RENDER_AUDIT = Symbol('QUOTATION_RENDER_AUDIT');

export interface RenderCandidate {
  tenantId: string;
  organizationId: string;
  versionId: string;
}

/** What the mapper needs of a version's rows, plus the issuing entity's legal name. */
export type RenderSource = Omit<CustomerViewInput, 'issuer' | 'renderedScanClean' | 'display'> & {
  issuerLegalName: string;
  /** The version's stored `document_style` as read (unchecked); null until its first render captured it. */
  documentStyle: unknown;
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
  /** Approved versions still `pending` since before `staleBefore`: the worker that claimed them died. */
  abandoned(staleBefore: Date, limit: number): Promise<RenderCandidate[]>;
  /**
   * Records a dead worker's try as failed, like markFailed: only a version still `pending` since before `staleBefore`
   * becomes `failed`, with one more failed attempt, so a live claim is never touched and two workers count it once.
   */
  markAbandoned(
    tx: DbTransaction,
    c: RenderCandidate,
    staleBefore: Date,
    now: Date,
  ): Promise<{ attempts: number; quotationId: string } | undefined>;
  /** One conditional UPDATE: true only for the caller that moved the version to `pending`. */
  claim(tx: DbTransaction, c: RenderCandidate, now: Date): Promise<boolean>;
  load(tx: DbTransaction, c: RenderCandidate): Promise<RenderSource | undefined>;
  /**
   * Stores the style on a version that has none yet and returns the one the version holds afterwards: the given
   * one, or, when another worker stored one first, that one. A stored style is never overwritten.
   */
  saveDocumentStyle(
    tx: DbTransaction,
    c: RenderCandidate,
    style: DocumentStyleSnapshot,
  ): Promise<unknown>;
  markRendered(
    tx: DbTransaction,
    c: RenderCandidate,
    rendered: { documentId: string; sha256: Buffer },
    now: Date,
  ): Promise<void>;
  /**
   * Only a version still `pending` becomes `failed`, with one more failed attempt: one that finished meanwhile is left
   * alone (undefined). Returns the attempts so far and the quotation, for the admin entry when they reach the limit.
   */
  markFailed(
    tx: DbTransaction,
    c: RenderCandidate,
    now: Date,
  ): Promise<{ attempts: number; quotationId: string } | undefined>;
  orphans(cutoff: Date, limit: number): Promise<OrphanDocument[]>;
  removeOrphan(tx: DbTransaction, o: OrphanDocument, now: Date): Promise<void>;
}

export type RunInTx = <T>(
  scope: TxScope,
  actor: Actor,
  fn: (tx: DbTransaction) => Promise<T>,
  /** READ_ONLY for a transaction that only reads, as withTx takes it. */
  options?: TxOptions,
) => Promise<T>;
export type RenderDocuments = Pick<DocumentsService, 'createGenerated' | 'receiveGenerated'>;
export type RenderSettings = Pick<SettingsService, 'get'>;
export interface PdfRenderer {
  htmlToPdf(html: string): Promise<Buffer>;
}
export type Clock = () => Date;
/** Turns the profile's logo document into bytes for the frozen style (DocumentLogoResolverFactory in the worker). */
export interface RenderLogos {
  forScope(scope: TxScope): DocumentLogoResolver;
}
/** The audit trail, as a port: AuditService.record in the worker, a fake in the tests. Every render sweeper uses it. */
export interface RenderAudit {
  record(tx: DbTransaction, e: AuditRecordInput): Promise<void>;
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
  if (
    error instanceof IssuerIncompleteError ||
    error instanceof RenderSourceMissingError ||
    error instanceof DocumentStyleInvalidError ||
    error instanceof DocumentLogoUnavailableError
  ) {
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
    @Inject(RENDER_LOGOS) private readonly logos: RenderLogos,
    @Inject(RENDER_AUDIT) private readonly audit: RenderAudit,
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
    // First count the tries of workers that died mid-render, so those versions go through the same pauses and limit.
    for (const c of await this.store.abandoned(this.staleBefore(), ABANDONED_BATCH)) {
      if (await this.recordAbandoned(c)) {
        result.failed += 1;
        result.failures.push({ versionId: c.versionId, kind: ABANDONED_KIND });
      }
    }
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

  /**
   * One version now: the sweep's single try, and the render an approval asked for (`quotation.render.one`). The claim
   * is the eligibility check (approved, not rendered, not pausing, not given up), so a version the sweep already took
   * is skipped before anything renders.
   */
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
      const source = await this.runTx(scope, actor, (tx) => this.store.load(tx, c), READ_ONLY);
      if (source === undefined) throw new RenderSourceMissingError();
      const { issuerLegalName, documentStyle: storedStyle, ...rows } = source;
      const issuer = await buildIssuer(this.settings, scope, issuerLegalName);
      const snapshot = await this.documentStyleOf(c, scope, actor, storedStyle);
      // The `render` purpose lets the mapper draw an approved version (a customer cannot see one) as the
      // document that will be sent. The file field stays null: this PDF is not its own attachment. The renderer
      // formats from `snapshot`, never from the view's display, so the display is the default.
      const view = toCustomerQuotationView(
        { ...rows, issuer, renderedScanClean: false, display: defaultPortalDisplay() },
        { purpose: 'render' },
      );
      const bytes = await this.pdf.htmlToPdf(renderQuotationHtml(view, { snapshot }));
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
      await this.recordFailure(c, kind, (tx) => this.store.markFailed(tx, c, this.clock()));
      return { outcome: 'failed', kind };
    }
  }

  private staleBefore(): Date {
    return new Date(this.clock().getTime() - PENDING_STALE_MS);
  }

  /** A claim left by a worker that died: one failed try, recorded like any other. True when this worker counted it. */
  private async recordAbandoned(c: RenderCandidate): Promise<boolean> {
    const staleBefore = this.staleBefore();
    const counted = await this.recordFailure(c, ABANDONED_KIND, (tx) =>
      this.store.markAbandoned(tx, c, staleBefore, this.clock()),
    );
    if (counted) {
      this.logger.warn(`quotation render failed: version=${c.versionId} kind=${ABANDONED_KIND}`);
    }
    return counted;
  }

  /**
   * One transaction: the failure and, when it used up the last try, the admin entry. The conditional UPDATE in `mark`
   * means only the worker that moved the version off `pending` counts it, so the entry is written once. True when the
   * failure was counted here.
   */
  private async recordFailure(
    c: RenderCandidate,
    kind: string,
    mark: (tx: DbTransaction) => Promise<{ attempts: number; quotationId: string } | undefined>,
  ): Promise<boolean> {
    const scope: TxScope = { tenantId: c.tenantId, organizationId: c.organizationId };
    try {
      return await this.runTx(scope, systemActor(QUOTATION_RENDER_JOB_PREFIX), async (tx) => {
        const failed = await mark(tx);
        if (failed === undefined) return false;
        if (failed.attempts !== MAX_RENDER_ATTEMPTS) return true;
        await this.audit.record(tx, {
          action: RENDER_GIVEN_UP_ACTION.quotation,
          entityType: 'quotations',
          entityId: failed.quotationId,
          after: { versionId: c.versionId, attempts: failed.attempts, failureKind: kind },
        });
        this.logger.error(
          `quotation render given up: version=${c.versionId} attempts=${failed.attempts} kind=${kind}`,
        );
        return true;
      });
    } catch (markError) {
      this.logger.error(
        `quotation render: could not record the failure: version=${c.versionId} kind=${failureKind(markError)}`,
      );
      return false;
    }
  }

  /**
   * The style this version renders with. One already stored is used as it is (checked again, so a bad row fails
   * with a kind); otherwise it is built from settings now and stored, in its own transaction, before the render:
   * a render that fails afterwards is retried with this same style. The store returns what the version holds, so
   * two workers that raced both render with the one that won.
   */
  private async documentStyleOf(
    c: RenderCandidate,
    scope: TxScope,
    actor: Actor,
    stored: unknown,
  ): Promise<DocumentStyleSnapshot> {
    if (stored !== null && stored !== undefined) return parseStoredDocumentStyle(stored);
    // The logo is frozen as bytes: a later change or removal of the logo never alters this version's document.
    const built = await buildDocumentStyleSnapshot(
      this.settings,
      scope,
      this.clock(),
      this.logos.forScope(scope),
    );
    const held = await this.runTx(scope, actor, (tx) => this.store.saveDocumentStyle(tx, c, built));
    // Nothing stored and nothing written: the claim was lost to another worker, like markRendered says.
    if (held === null || held === undefined) throw new Error('render claim was lost');
    return parseStoredDocumentStyle(held);
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
  /**
   * None, or failed with tries left and its pause over. A claim left by a worker that died is first recorded as a
   * failed try (markAbandoned), so it comes back here with its pause and its limit. The pause depends on the version's
   * own render_attempts, so there is one branch per count below the limit; 0 is a version that failed before attempts
   * were counted (0115), which waits the first pause. A version at the limit is given up and never matches.
   */
  const failedAndDue = (now: Date) =>
    or(
      ...Array.from({ length: MAX_RENDER_ATTEMPTS }, (_, attempts) =>
        and(
          eq(quotationVersions.renderAttempts, attempts),
          lt(
            quotationVersions.updatedAt,
            new Date(now.getTime() - (nextRetryPauseMs(Math.max(attempts, 1)) ?? 0)),
          ),
        ),
      ),
    );
  const needsRender = (now: Date) =>
    or(
      eq(quotationVersions.renderState, 'none'),
      and(eq(quotationVersions.renderState, 'failed'), failedAndDue(now)),
    );
  const abandonedSince = (staleBefore: Date) =>
    and(
      eq(quotationVersions.status, 'approved'),
      eq(quotationVersions.renderState, 'pending'),
      lt(quotationVersions.updatedAt, staleBefore),
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

    async abandoned(staleBefore, limit) {
      return db
        .select({
          tenantId: quotationVersions.tenantId,
          organizationId: quotationVersions.organizationId,
          versionId: quotationVersions.id,
        })
        .from(quotationVersions)
        .where(abandonedSince(staleBefore))
        .orderBy(asc(quotationVersions.updatedAt))
        .limit(limit);
    },

    async markAbandoned(tx, c, staleBefore, now) {
      const [row] = await tx
        .update(quotationVersions)
        .set({
          renderState: 'failed',
          renderAttempts: sql`${quotationVersions.renderAttempts} + 1`,
          updatedAt: now,
        })
        .where(and(ownVersion(c), abandonedSince(staleBefore)))
        .returning({
          attempts: quotationVersions.renderAttempts,
          quotationId: quotationVersions.quotationId,
        });
      return row;
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
      const [found] = await tx
        .select({
          documentStyle: quotationVersions.documentStyle,
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
          termsAndConditions: quotationVersions.termsAndConditions,
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
      if (found === undefined) return undefined;
      const { documentStyle, ...version } = found;

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
          country: customers.country,
          addressLine: customers.addressLine,
          addressCity: customers.addressCity,
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
        documentStyle,
      };
    },

    async saveDocumentStyle(tx, c, style) {
      // Written once: only a version with no style takes this one, and only while this worker holds the claim.
      // The database refuses any later change as well (quotation_versions_document_style_guard, 0046).
      await tx
        .update(quotationVersions)
        .set({ documentStyle: style })
        .where(
          and(
            ownVersion(c),
            eq(quotationVersions.renderState, 'pending'),
            isNull(quotationVersions.documentStyle),
          ),
        );
      const [row] = await tx
        .select({ documentStyle: quotationVersions.documentStyle })
        .from(quotationVersions)
        .where(ownVersion(c))
        .limit(1);
      return row?.documentStyle ?? null;
    },

    async markRendered(tx, c, rendered, now) {
      const rows = await tx
        .update(quotationVersions)
        .set({
          renderedDocumentId: rendered.documentId,
          renderedSha256: rendered.sha256,
          renderState: 'rendered',
          renderAttempts: 0,
          updatedAt: now,
        })
        .where(and(ownVersion(c), eq(quotationVersions.renderState, 'pending')))
        .returning({ id: quotationVersions.id });
      // Not pending any more: another worker took over a stale claim. Say so instead of claiming success.
      if (rows.length !== 1) throw new Error('render claim was lost');
    },

    async markFailed(tx, c, now) {
      const [row] = await tx
        .update(quotationVersions)
        .set({
          renderState: 'failed',
          renderAttempts: sql`${quotationVersions.renderAttempts} + 1`,
          updatedAt: now,
        })
        .where(and(ownVersion(c), eq(quotationVersions.renderState, 'pending')))
        .returning({
          attempts: quotationVersions.renderAttempts,
          quotationId: quotationVersions.quotationId,
        });
      return row;
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
    if (job.name === QUOTATION_RENDER_ONE_JOB) {
      const { tenantId, organizationId, id } = RenderOneJobSchema.parse(job.data);
      await this.sweeper.renderOne({ tenantId, organizationId, versionId: id });
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
