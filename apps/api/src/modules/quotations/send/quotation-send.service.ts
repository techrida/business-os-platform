// QuotationSendService: an approved quotation version goes to the customer (Q3a). Serves the NFRs:
// - "a customer never gets an unsafe or stale file": only an approved version whose PDF is rendered, whose newest
//   document version scanned clean, and whose valid_until is today or later in Asia/Kathmandu can be sent; each
//   blocker is a 409 with its own code;
// - "email a portal link, never a file" (ADR 0023): the email is K5's quotation.sent template, whose only link is
//   PORTAL_PUBLIC_URL/quotations/<quotationId>, and a rendered email has no attachment slot;
// - "a business change and its notices commit together": the status move, history row, audit event, opportunity
//   move and outbox row are written in one transaction; the drainer is nudged only after the commit;
// - "no double effects": the send runs inside withIdempotency, so a retried POST returns the first answer and
//   queues no second email (the outbox dedupe key is the version id as well);
// - "authorization is deny-by-default" and "one legal entity at a time": the version is read in the acting entity
//   only (another entity's id is a 404), and the quotation's owner decides the `own` scope of quotation.send.
//
// Not done here: a hard-bounced address does not block the send. K5 marks bounced outbox rows, but there is no
// suppression list to consult yet; add the check when one exists.
import {
  type DocumentVersionStatus,
  type Permission,
  type QuotationVersionDto,
  type SendQuotationBody,
} from '@bos/contracts';
import {
  customerContacts,
  customers,
  documentVersions,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  scoped,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { type ResourceRef } from '../../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { NotifyService } from '../../../platform/notify/notify.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { versionVisibleTo } from '../drafting/cost-visibility';
import {
  toQuotationVersionDto,
  type QuotationLineRow,
  type QuotationRow,
  type QuotationTaxSummaryRow,
  type QuotationVersionRow,
} from '../drafting/mapping';
import { quotationRef } from '../preview/quotation-preview.service';
import { kathmanduDay } from '../reference/reference.types';
import { QuotationSendCaller } from './quotation-send.caller';

/** Injection token for a test clock; production falls back to the system time. */
export const QUOTATION_SEND_CLOCK = Symbol('QUOTATION_SEND_CLOCK');

const SEND_ACTION: Permission = 'quotation.send';
const AUDIT_ENTITY = 'quotations';

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Quotation not found' });
const refused = (code: string, message: string) => new ConflictException({ code, message });
const badRecipient = (message: string) =>
  new BadRequestException({ code: 'invalid_recipient', message });

/** The version with its quotation, as the send reads it. */
export interface SendHead {
  quotation: Pick<
    QuotationRow,
    | 'id'
    | 'number'
    | 'tenantId'
    | 'organizationId'
    | 'ownerUserId'
    | 'customerPartyId'
    | 'opportunityId'
  >;
  version: QuotationVersionRow;
}

export interface SendRecipient {
  id: string;
  fullName: string;
  emailNorm: string | null;
}

/** The database reads and writes of a send, apart from the service so its unit test needs no Postgres. */
@Injectable()
export class QuotationSendStore {
  /** The version with its quotation, in the acting entity only; 404 when it is not there or not that quotation's. */
  async load(
    tx: DbTransaction,
    scope: TxScope,
    quotationId: string,
    versionId: string,
  ): Promise<SendHead> {
    const [row] = await tx
      .select({
        version: quotationVersions,
        quotation: {
          id: quotations.id,
          number: quotations.number,
          tenantId: quotations.tenantId,
          organizationId: quotations.organizationId,
          ownerUserId: quotations.ownerUserId,
          customerPartyId: quotations.customerPartyId,
          opportunityId: quotations.opportunityId,
        },
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
        scoped(scope).where(
          quotationVersions,
          and(eq(quotationVersions.id, versionId), eq(quotationVersions.quotationId, quotationId)),
        ),
      )
      .limit(1);
    if (row === undefined) throw notFound();
    return row;
  }

  /**
   * The scan status of the rendered document's newest upload, or null when it has none. Read the way drafting reads
   * renderedScanStatus: documents.current_version_id is the newest *clean* one, so it would hide a pending scan.
   */
  async renderedScanStatus(
    tx: DbTransaction,
    tenantId: string,
    documentId: string,
  ): Promise<DocumentVersionStatus | null> {
    const [row] = await tx
      .select({ status: documentVersions.status })
      .from(documentVersions)
      .where(
        and(eq(documentVersions.tenantId, tenantId), eq(documentVersions.documentId, documentId)),
      )
      .orderBy(desc(documentVersions.version))
      .limit(1);
    return row?.status ?? null;
  }

  /** The contact, only when it belongs to `customerId`; undefined for an unknown id or another customer's. */
  async contact(
    tx: DbTransaction,
    tenantId: string,
    customerId: string,
    contactId: string,
  ): Promise<SendRecipient | undefined> {
    const [row] = await tx
      .select({
        id: customerContacts.id,
        fullName: customerContacts.fullName,
        emailNorm: customerContacts.emailNorm,
      })
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, tenantId),
          eq(customerContacts.customerId, customerId),
          eq(customerContacts.id, contactId),
        ),
      )
      .limit(1);
    return row;
  }

  /** The customer's legal name for the email; undefined when the tenant has no such customer. */
  async customerName(
    tx: DbTransaction,
    tenantId: string,
    customerId: string,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ legalName: customers.legalName })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
      .limit(1);
    return row?.legalName;
  }

  /** The version's lines and tax summary, for the returned DTO. */
  async parts(
    tx: DbTransaction,
    tenantId: string,
    versionId: string,
  ): Promise<{ lines: QuotationLineRow[]; taxSummary: QuotationTaxSummaryRow[] }> {
    const lines = await tx
      .select()
      .from(quotationLines)
      .where(and(eq(quotationLines.tenantId, tenantId), eq(quotationLines.versionId, versionId)))
      .orderBy(asc(quotationLines.lineNo));
    const taxSummary = await tx
      .select()
      .from(quotationTaxSummary)
      .where(
        and(
          eq(quotationTaxSummary.tenantId, tenantId),
          eq(quotationTaxSummary.versionId, versionId),
        ),
      );
    return { lines, taxSummary };
  }

  async appendHistory(
    tx: DbTransaction,
    row: typeof quotationStatusHistory.$inferInsert,
  ): Promise<void> {
    await tx.insert(quotationStatusHistory).values(row);
  }
}

@Injectable()
export class QuotationSendService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly opportunities: OpportunitiesService,
    private readonly notify: NotifyService,
    private readonly store: QuotationSendStore,
    private readonly caller: QuotationSendCaller,
    @Optional()
    @Inject(QUOTATION_SEND_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Sends the version to the recipient contact and returns it as a QuotationVersionDto (status sent). 404 outside
   * the caller's entity or scope; 409 `quotation_not_approved`, `quotation_not_rendered`,
   * `quotation_scan_not_clean` or `quotation_expired`, or 409 `conflict` for a stale expectedVersion; 400
   * `invalid_recipient` for a contact that is not the customer's or has no email.
   */
  async send(
    quotationId: string,
    versionId: string,
    body: SendQuotationBody,
    idempotencyKey: string,
  ): Promise<QuotationVersionDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    // The stored answer (replayed on a retry) is the full DTO; the cost figures are dropped for this caller per reply.
    const dto = await withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        {
          command: 'quotation.send',
          key: idempotencyKey,
          // The ids are part of the hashed body: one key cannot replay onto another version.
          body: { quotationId, versionId, ...body },
        },
        async () => ({
          status: 200,
          response: await this.sendInTx(tx, scope, actor, { quotationId, versionId, body, now }),
        }),
      );
      return done.response;
    });
    // After the commit, never inside it (notify.service.ts header). Never throws.
    await this.notify.nudge();
    return versionVisibleTo(principal, dto);
  }

  private async sendInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    i: { quotationId: string; versionId: string; body: SendQuotationBody; now: Date },
  ): Promise<QuotationVersionDto> {
    const { quotation, version } = await this.store.load(tx, scope, i.quotationId, i.versionId);
    this.assertVisible(quotationRef(quotation));

    if (version.status !== 'approved') {
      throw refused(
        'quotation_not_approved',
        `A ${version.status} version cannot be sent; only an approved version can`,
      );
    }
    if (version.version !== i.body.expectedVersion) {
      throw refused('conflict', 'This record was changed by someone else; reload it and try again');
    }
    if (version.renderState !== 'rendered' || version.renderedDocumentId === null) {
      throw refused(
        'quotation_not_rendered',
        'The quotation PDF is not ready yet; try again when it has been generated',
      );
    }
    const scan = await this.store.renderedScanStatus(
      tx,
      quotation.tenantId,
      version.renderedDocumentId,
    );
    if (scan !== 'clean') {
      throw refused(
        'quotation_scan_not_clean',
        'The quotation PDF has not passed the virus scan yet; it cannot be sent',
      );
    }
    // ISO dates compare correctly as text. valid_until is the last day the quotation stands.
    if (kathmanduDay(i.now) > version.validUntil) {
      throw refused(
        'quotation_expired',
        `This quotation expired on ${version.validUntil}; revise it to send a new one`,
      );
    }
    if (quotation.customerPartyId === null) {
      throw refused('quotation_no_customer', 'A quotation without a customer cannot be sent');
    }

    const recipient = await this.store.contact(
      tx,
      quotation.tenantId,
      quotation.customerPartyId,
      i.body.recipientContactId,
    );
    if (recipient === undefined) {
      throw badRecipient("The recipient must be one of the quotation customer's contacts");
    }
    if (recipient.emailNorm === null) {
      throw badRecipient('The recipient has no email address');
    }
    const customerName =
      (await this.store.customerName(tx, quotation.tenantId, quotation.customerPartyId)) ?? '';

    // S2's guard allows approved -> sent; the row version guards against a concurrent change.
    const sent = await updateVersioned(tx, quotationVersions, version.id, i.body.expectedVersion, {
      status: 'sent',
      sentAt: i.now,
      updatedAt: i.now,
    });
    await this.store.appendHistory(tx, {
      tenantId: version.tenantId,
      organizationId: version.organizationId,
      versionId: version.id,
      fromStatus: version.status,
      toStatus: 'sent',
      actorId: actor.kind === 'user' ? actor.id : null,
      at: i.now,
    });
    await this.audit.record(tx, {
      action: 'quotation.sent',
      entityType: AUDIT_ENTITY,
      entityId: quotation.id,
      before: { versionId: version.id, status: version.status },
      after: {
        versionId: version.id,
        status: 'sent',
        recipientContactId: recipient.id,
        // K5's quotation.sent template has no slot for a free-text note, so it is kept here, not emailed.
        message: i.body.message ?? null,
      },
    });
    await this.opportunities.markQuotationSent(tx, quotation.opportunityId);
    await this.notify.notifyEmail(tx, {
      toEmail: recipient.emailNorm,
      template: 'quotation.sent',
      data: {
        quotationNumber: quotation.number,
        customerName,
        validUntil: version.validUntil,
        // A path, not a URL: renderEmail prefixes PORTAL_PUBLIC_URL and refuses anything else. The portal's
        // `/quotations/:id` is a version id (PortalService.get), so the link names the version just sent.
        linkPath: `/quotations/${version.id}`,
      },
      dedupeKey: `quotation.sent:${version.id}`,
    });

    const parts = await this.store.parts(tx, quotation.tenantId, version.id);
    return toQuotationVersionDto({
      quotation,
      version: sent,
      lines: parts.lines,
      taxSummary: parts.taxSummary,
      renderedScanStatus: scan,
    });
  }

  /**
   * Record-level authz that answers 404, not 403, for a quotation outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertVisible(ref: ResourceRef): void {
    try {
      this.authz.assert(SEND_ACTION, ref);
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }
}
