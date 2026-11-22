// The vendor portal's inbox writes (P4 unit PV2): KYC documents and quotation submissions. Serves done check 13 and
// the NFRs "a vendor sees only what we meant to show" and "deny by default":
// - only a vendor principal with a party gets in (assertVendorCaller, 403 before any query); what it may do is read
//   live from its vendor status: KYC uploads need `onboarding` (a pending_kyc vendor has it), quotation submissions
//   need `submit` (approved vendors only), so the status check answers 403 before any id is looked at;
// - every upload is two steps, as on /v1/documents: POST declares the file and returns `uploadPath`, then a raw PUT
//   of the bytes. Both go through DocumentsService, so the type and size limits, quarantine and the virus scan are
//   the platform's; the owner policy's `allowsCounterparty` decides the upload, never a wider grant;
// - the owner is decided here from the caller's party, never from the body; a document, version, case or RFQ that is
//   not the caller's (a bad id, a missing one, another vendor's) is the same 404, checked before DocumentsService is
//   asked, so a stranger never sees the 403 the grant check would give;
// - a submission writes only an inbox row: the KYC file goes on the vendor's own KYB case checklist (staff review
//   it), a quotation becomes a `vendor_quotation_submissions` row `received`, a bill a `vendor_bill_submissions` row
//   `received`. No vendor_quotations or vendor_bills row is written; staff convert the inbox row later. Each
//   row-creating POST honours the Idempotency-Key;
// - a quotation or bill in a currency the company has not switched on is refused with 422 CURRENCY_NOT_ENABLED (D44),
//   as staff could not convert it. The setting is read before the transaction, but the refusal is thrown inside the
//   idempotency callback, so a retry of a submission that already went through replays its stored answer;
// - a bank change request is only a proposal: VendorBankService.proposeFromPortal writes a `proposed` account that
//   staff verify with call-back evidence, and the answer shows the last four digits only. The contract's
//   `supportingDocumentId` has no column, so a value is refused with 422 `supporting_document_unsupported`.
import type { Readable } from 'node:stream';

import {
  ChecklistItemSchema,
  CreateDocumentBodySchema,
  isVendorVisiblePoStatus,
  vendorPortalCapability,
  VendorBankChangeRequestBodySchema,
  VendorBillSubmissionBodySchema,
  VendorKycDocumentSubmissionBodySchema,
  VendorQuotationSubmissionBodySchema,
  type DocumentVersionDto,
  type VendorBankAccountDto,
  type VendorKycDocType,
} from '@bos/contracts';
import {
  documents,
  documentVersions,
  purchaseOrders,
  rfqs,
  rfqVendors,
  scoped,
  vendorBillSubmissions,
  vendorQuotationSubmissions,
  vendors,
  verificationCases,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { assertNotInfected, DocumentsService } from '../../../platform/documents/documents.service';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import { SettingsService } from '../../../platform/settings/settings.service';
import {
  assertVendorCaller,
  assertVendorCapability,
  VendorPortalCaller,
  type VendorPortalNeed,
} from '../../portal/vendor-portal.caller';
import {
  attachDocument,
  checklistKeysFor,
  isEditable,
  requiresExpiry,
} from '../../verification/verification.rules';
import {
  RFQ_DEADLINE_PASSED,
  RFQ_DEADLINE_PASSED_MESSAGE,
} from '../../procurement/sourcing/sourcing.rules';
import { assertInvoiceDateByToday } from '../../payables/bills/vendor-bill.rules';
import { VERIFICATION_OWNER_TYPE } from '../../verification/verification.types';
import { stripAccountSpaces } from '../../vendors/bank/bank.rules';
import { VendorBankService } from '../../vendors/bank/bank.service';
import { VENDOR_INTAKE_OWNER_TYPE } from './vendor-intake.policy';

const Id = z.guid();

/** What the client declares about the file. The owner is decided here, never by the body. */
export const PortalFileSchema = CreateDocumentBodySchema.pick({
  filename: true,
  declaredMime: true,
  sizeBytes: true,
});

export interface CreatedPortalFile {
  documentId: string;
  versionId: string;
  uploadPath: string;
}

/** A KYC document on the vendor's own case checklist, waiting for staff review. */
export interface KycDocumentReceipt {
  docType: VendorKycDocType;
  documentId: string;
  validUntil: string | null;
  state: 'submitted';
}

/** An inbox row as the vendor sees it: no staff field. */
export interface InboxReceipt {
  id: string;
  documentId: string;
  status: 'received';
  receivedAt: string;
}

/** The request's scope and actor, as `requestTx()` gives them. */
export interface InboxCaller {
  scope: TxScope;
  actor: Actor;
}

/** The one refusal for anything the caller may not see. */
export const VENDOR_INBOX_NOT_FOUND = 'Not found';
const notFound = () => new NotFoundException(VENDOR_INBOX_NOT_FOUND);

export const kycUploadPath = (documentId: string, versionId: string): string =>
  `/v1/portal/vendor/kyc-documents/files/${documentId}/versions/${versionId}/content`;
export const quotationUploadPath = (documentId: string, versionId: string): string =>
  `/v1/portal/vendor/quotation-submissions/files/${documentId}/versions/${versionId}/content`;
export const billUploadPath = (documentId: string, versionId: string): string =>
  `/v1/portal/vendor/bill-submissions/files/${documentId}/versions/${versionId}/content`;

/** Field names only: echoing values back would reflect attacker-controlled text. */
function invalid(what: string, error: z.ZodError): BadRequestException {
  const fields = [...new Set(error.issues.map((i) => i.path.join('.') || 'body'))];
  return new BadRequestException(`Invalid ${what}: ${fields.join(', ')}`);
}

/** File versions whose bytes arrived (scanning or scanned clean); anything else is not a submittable file. */
const RECEIVED_STATUSES = ['quarantined', 'clean'] as const;

/** Injection token for a test clock; production falls back to the system time. */
export const VENDOR_PORTAL_INBOX_CLOCK = Symbol('VENDOR_PORTAL_INBOX_CLOCK');

@Injectable()
export class VendorPortalInboxService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly caller: VendorPortalCaller,
    private readonly bank: VendorBankService,
    // The D44 currency check; SettingsModule provides it. The fallback reads the same settings through `db`, so a
    // test that builds the service by hand gets the real check.
    @Optional()
    private readonly currencies: CurrencyEnabledService = new CurrencyEnabledService(
      new SettingsService(db),
    ),
    @Optional()
    @Inject(VENDOR_PORTAL_INBOX_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------------------------------------- KYC documents

  /** Creates a KYC file (version 1, awaiting_content) on the caller's own vendor case. 404 when it has none. */
  async createKycFile(who: InboxCaller, body: unknown): Promise<CreatedPortalFile> {
    const { partyId } = await this.access('onboarding');
    const file = PortalFileSchema.safeParse(body);
    if (!file.success) throw invalid('file', file.error);
    const caseId = await this.ownCaseId(this.db, who.scope.tenantId, partyId);
    if (caseId === undefined) throw notFound();
    const created = await withTx(this.db, who.scope, who.actor, (tx) =>
      this.documents.create(tx, {
        ownerType: VERIFICATION_OWNER_TYPE,
        ownerId: caseId,
        ...file.data,
      }),
    );
    return { ...created, uploadPath: kycUploadPath(created.documentId, created.versionId) };
  }

  /** Streams the bytes of a KYC file of the caller's own case into the documents pipeline. */
  async receiveKycFile(
    who: InboxCaller,
    documentId: string,
    versionId: string,
    src: Readable,
    contentLength: number,
  ): Promise<DocumentVersionDto> {
    const { partyId } = await this.access('onboarding');
    const caseId = await this.ownCaseId(this.db, who.scope.tenantId, partyId);
    if (caseId === undefined) throw notFound();
    await this.assertVersion(who.scope, VERIFICATION_OWNER_TYPE, caseId, documentId, versionId);
    return this.documents.receiveContent(versionId, src, contentLength, { documentId, who });
  }

  /**
   * Puts an uploaded KYC file on the item `docType` of the caller's own case. The same rules as the staff route
   * (verification.rules): an editable case only (409), an expiry where the item needs one (422), and editing a
   * rejected case sends it back to draft. The case row is locked and its own version is used, so a concurrent
   * staff edit is serialised, not lost.
   */
  async submitKycDocument(
    who: InboxCaller,
    body: unknown,
    idempotencyKey: string,
  ): Promise<KycDocumentReceipt> {
    const { partyId } = await this.access('onboarding');
    const parsed = VendorKycDocumentSubmissionBodySchema.safeParse(body);
    if (!parsed.success) throw invalid('KYC document', parsed.error);
    const b = parsed.data;
    const done = await withTx(this.db, who.scope, who.actor, (tx) =>
      withIdempotency(
        tx,
        { command: 'portal.vendor.kyc_document', key: idempotencyKey, body: b },
        async () => {
          const [row] = await tx
            .select()
            .from(verificationCases)
            .where(
              and(
                eq(verificationCases.tenantId, who.scope.tenantId),
                eq(verificationCases.partyId, partyId),
                eq(verificationCases.partyKind, 'vendor'),
              ),
            )
            .for('update');
          if (row === undefined) throw notFound();
          await this.assertDocument(tx, who.scope, VERIFICATION_OWNER_TYPE, row.id, b.documentId);
          if (!isEditable(row.status)) {
            throw new ConflictException({
              code: 'conflict',
              message: `A case in status ${row.status} cannot be changed`,
            });
          }
          if (!checklistKeysFor('vendor').includes(b.docType)) {
            throw new UnprocessableEntityException({
              code: 'unprocessable',
              message: `${b.docType} is not on the checklist of a vendor case`,
            });
          }
          if (requiresExpiry(b.docType) && b.validUntil === undefined) {
            throw new UnprocessableEntityException({
              code: 'unprocessable',
              message: `${b.docType} needs validUntil`,
            });
          }
          const before = ChecklistItemSchema.array().parse(row.checklist);
          const after = attachDocument(before, b.docType, b.documentId, b.validUntil ?? null);
          const reopen = row.status === 'rejected';
          await updateVersioned(tx, verificationCases, row.id, row.version, {
            checklist: after,
            ...(reopen && {
              status: 'draft' as const,
              reviewerUserId: null,
              decidedAt: null,
              reason: null,
            }),
            updatedAt: new Date(),
          });
          await this.audit.record(tx, {
            action: 'verification.checklist_updated',
            entityType: 'verification_case',
            entityId: row.id,
            before: before.find((i) => i.key === b.docType) ?? null,
            after: after.find((i) => i.key === b.docType),
            meta: { key: b.docType, documentId: b.documentId, reopened: reopen, via: 'portal' },
          });
          const response: KycDocumentReceipt = {
            docType: b.docType,
            documentId: b.documentId,
            validUntil: b.validUntil ?? null,
            state: 'submitted',
          };
          return { status: 201, response };
        },
      ),
    );
    return done.response;
  }

  // ------------------------------------------------------------------------------------- quotation submissions

  /** Creates a quotation file (version 1, awaiting_content) owned by the caller's own party. */
  async createQuotationFile(who: InboxCaller, body: unknown): Promise<CreatedPortalFile> {
    const { partyId } = await this.access('submit');
    const file = PortalFileSchema.safeParse(body);
    if (!file.success) throw invalid('file', file.error);
    const created = await withTx(this.db, who.scope, who.actor, (tx) =>
      this.documents.create(tx, {
        ownerType: VENDOR_INTAKE_OWNER_TYPE,
        ownerId: partyId,
        ...file.data,
      }),
    );
    return { ...created, uploadPath: quotationUploadPath(created.documentId, created.versionId) };
  }

  /** Streams the bytes of a quotation file of the caller's own party into the documents pipeline. */
  async receiveQuotationFile(
    who: InboxCaller,
    documentId: string,
    versionId: string,
    src: Readable,
    contentLength: number,
  ): Promise<DocumentVersionDto> {
    const { partyId } = await this.access('submit');
    await this.assertVersion(who.scope, VENDOR_INTAKE_OWNER_TYPE, partyId, documentId, versionId);
    return this.documents.receiveContent(versionId, src, contentLength, { documentId, who });
  }

  /**
   * Records a quotation for an open RFQ the caller is invited to, as a `received` inbox row. An RFQ the caller is not
   * invited to (or another entity's, or a closed one) and a file that is not the caller's are the same 404.
   */
  async submitQuotation(
    who: InboxCaller,
    body: unknown,
    idempotencyKey: string,
  ): Promise<InboxReceipt> {
    const { p, partyId } = await this.access('submit');
    const parsed = VendorQuotationSubmissionBodySchema.safeParse(body);
    if (!parsed.success) throw invalid('quotation submission', parsed.error);
    const b = parsed.data;
    const refusal = await this.currencyRefusal(who.scope, b.currency);
    const done = await withTx(this.db, who.scope, who.actor, (tx) =>
      withIdempotency(
        tx,
        { command: 'portal.vendor.quotation_submission', key: idempotencyKey, body: b },
        async () => {
          if (refusal !== undefined) throw refusal;
          // F1-Q47: `late` is read at the database's time, the same clock that stamps `received_at`.
          const [invited] = await tx
            .select({ id: rfqVendors.id, late: sql<boolean>`now() > ${rfqs.deadline}` })
            .from(rfqVendors)
            .innerJoin(
              rfqs,
              and(
                eq(rfqs.tenantId, rfqVendors.tenantId),
                eq(rfqs.organizationId, rfqVendors.organizationId),
                eq(rfqs.id, rfqVendors.rfqId),
              ),
            )
            .where(
              and(
                eq(rfqVendors.tenantId, who.scope.tenantId),
                eq(rfqVendors.organizationId, who.scope.organizationId),
                eq(rfqVendors.rfqId, b.rfqId),
                eq(rfqVendors.vendorId, partyId),
                eq(rfqs.status, 'open'),
              ),
            )
            .for('share');
          if (invited === undefined) throw notFound();
          if (invited.late) {
            throw new ConflictException({
              code: RFQ_DEADLINE_PASSED,
              message: RFQ_DEADLINE_PASSED_MESSAGE,
            });
          }
          await this.assertDocument(tx, who.scope, VENDOR_INTAKE_OWNER_TYPE, partyId, b.documentId);
          const [row] = await tx
            .insert(vendorQuotationSubmissions)
            .values(
              scoped(who.scope).values({
                vendorId: partyId,
                rfqId: b.rfqId,
                submittedBy: p.userId,
                documentId: b.documentId,
                vendorRef: b.vendorRef ?? null,
              }),
            )
            .returning({
              id: vendorQuotationSubmissions.id,
              receivedAt: vendorQuotationSubmissions.receivedAt,
            });
          if (row === undefined) throw new Error('quotation submission insert returned no row');
          await this.audit.record(tx, {
            action: 'portal.vendor.quotation_submitted',
            entityType: 'vendor_quotation_submission',
            entityId: row.id,
            after: {
              rfqId: b.rfqId,
              documentId: b.documentId,
              currency: b.currency,
              total: b.total,
            },
          });
          const response: InboxReceipt = {
            id: row.id,
            documentId: b.documentId,
            status: 'received',
            receivedAt: row.receivedAt.toISOString(),
          };
          return { status: 201, response };
        },
      ),
    );
    return done.response;
  }

  // ------------------------------------------------------------------------------------------ bill submissions

  /** Creates a bill file (version 1, awaiting_content) owned by the caller's own party, like a quotation file. */
  async createBillFile(who: InboxCaller, body: unknown): Promise<CreatedPortalFile> {
    const { partyId } = await this.access('submit');
    const file = PortalFileSchema.safeParse(body);
    if (!file.success) throw invalid('file', file.error);
    const created = await withTx(this.db, who.scope, who.actor, (tx) =>
      this.documents.create(tx, {
        ownerType: VENDOR_INTAKE_OWNER_TYPE,
        ownerId: partyId,
        ...file.data,
      }),
    );
    return { ...created, uploadPath: billUploadPath(created.documentId, created.versionId) };
  }

  /** Streams the bytes of a bill file of the caller's own party into the documents pipeline. */
  async receiveBillFile(
    who: InboxCaller,
    documentId: string,
    versionId: string,
    src: Readable,
    contentLength: number,
  ): Promise<DocumentVersionDto> {
    const { partyId } = await this.access('submit');
    await this.assertVersion(who.scope, VENDOR_INTAKE_OWNER_TYPE, partyId, documentId, versionId);
    return this.documents.receiveContent(versionId, src, contentLength, { documentId, who });
  }

  /**
   * Records the vendor's claimed bill as a `received` inbox row; staff key the real bill later. The optional purchase
   * order must be the caller's own and in a status a vendor may see (isVendorVisiblePoStatus, as on the PO views);
   * any other order, and a file that is not the caller's, is the same 404. The contract's `currency` and
   * `claimedTotal` have no column on the row: they are kept in the audit event's `after` only.
   */
  async submitBill(who: InboxCaller, body: unknown, idempotencyKey: string): Promise<InboxReceipt> {
    const { p, partyId } = await this.access('submit');
    const parsed = VendorBillSubmissionBodySchema.safeParse(body);
    if (!parsed.success) throw invalid('bill submission', parsed.error);
    const b = parsed.data;
    assertInvoiceDateByToday(b.invoiceDate, this.clock());
    const refusal = await this.currencyRefusal(who.scope, b.currency);
    const done = await withTx(this.db, who.scope, who.actor, (tx) =>
      withIdempotency(
        tx,
        { command: 'portal.vendor.bill_submission', key: idempotencyKey, body: b },
        async () => {
          if (refusal !== undefined) throw refusal;
          if (b.purchaseOrderId !== undefined) {
            const [po] = await tx
              .select({ status: purchaseOrders.status })
              .from(purchaseOrders)
              .where(
                and(
                  eq(purchaseOrders.tenantId, who.scope.tenantId),
                  eq(purchaseOrders.organizationId, who.scope.organizationId),
                  eq(purchaseOrders.id, b.purchaseOrderId),
                  eq(purchaseOrders.vendorId, partyId),
                ),
              )
              .for('share');
            if (po === undefined || !isVendorVisiblePoStatus(po.status)) throw notFound();
          }
          await this.assertDocument(tx, who.scope, VENDOR_INTAKE_OWNER_TYPE, partyId, b.documentId);
          const [row] = await tx
            .insert(vendorBillSubmissions)
            .values(
              scoped(who.scope).values({
                vendorPartyId: partyId,
                purchaseOrderId: b.purchaseOrderId ?? null,
                submittedBy: p.userId,
                documentId: b.documentId,
                vendorInvoiceNo: b.vendorInvoiceNo,
                invoiceDate: b.invoiceDate,
              }),
            )
            .returning({
              id: vendorBillSubmissions.id,
              receivedAt: vendorBillSubmissions.receivedAt,
            });
          if (row === undefined) throw new Error('bill submission insert returned no row');
          await this.audit.record(tx, {
            action: 'portal.vendor.bill_submitted',
            entityType: 'vendor_bill_submission',
            entityId: row.id,
            after: {
              purchaseOrderId: b.purchaseOrderId ?? null,
              documentId: b.documentId,
              vendorInvoiceNo: b.vendorInvoiceNo,
              invoiceDate: b.invoiceDate,
              currency: b.currency,
              claimedTotal: b.claimedTotal,
            },
          });
          const response: InboxReceipt = {
            id: row.id,
            documentId: b.documentId,
            status: 'received',
            receivedAt: row.receivedAt.toISOString(),
          };
          return { status: 201, response };
        },
      ),
    );
    return done.response;
  }

  // ----------------------------------------------------------------------------------- bank change requests

  /**
   * A bank change request is a proposal for the caller's own vendor (the party comes from the principal, never the
   * body), written by VendorBankService.proposeFromPortal as a `proposed` account that staff verify. Spaces in the
   * account number are stripped before the contract parses it. The answer is the bank DTO: last four digits only.
   * `supportingDocumentId` has no column, so a value is refused with 422 rather than dropped.
   */
  async requestBankChange(
    who: InboxCaller,
    body: unknown,
    idempotencyKey: string,
  ): Promise<VendorBankAccountDto> {
    const { partyId } = await this.access('submit');
    const parsed = VendorBankChangeRequestBodySchema.safeParse(stripAccountSpaces(body));
    if (!parsed.success) throw invalid('bank change request', parsed.error);
    const { supportingDocumentId, ...fields } = parsed.data;
    if (supportingDocumentId !== undefined) {
      throw new UnprocessableEntityException({
        code: 'supporting_document_unsupported',
        message: 'A supporting document cannot be attached to a bank change request yet',
      });
    }
    return this.bank.proposeFromPortal(who.scope, partyId, fields, idempotencyKey);
  }

  // ------------------------------------------------------------------------------------------------- helpers

  /**
   * What the currency check (D44) threw for `currency`, usually 422 CURRENCY_NOT_ENABLED, or undefined when the company
   * has it on. A pool read, so it runs before the transaction opens; the caller throws the refusal inside its
   * idempotency callback, as PaymentsService.submit does, so a retry of a submission that already went through still
   * replays its stored answer.
   */
  private async currencyRefusal(scope: TxScope, currency: string): Promise<Error | undefined> {
    try {
      await this.currencies.assertEnabled(scope, currency);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error('currency check failed', { cause: error });
    }
  }

  /** The vendor caller and its party, after the live status allows `need` (403 otherwise). */
  private async access(need: VendorPortalNeed): Promise<{ p: Principal; partyId: string }> {
    const p = this.caller.current();
    // A staff or customer principal is refused before any query.
    const partyId = assertVendorCaller(p);
    const [row] = await this.db
      .select({ status: vendors.status })
      .from(vendors)
      .where(and(eq(vendors.tenantId, p.tenantId), eq(vendors.id, partyId)));
    assertVendorCapability(row === undefined ? 'none' : vendorPortalCapability(row.status), need);
    return { p, partyId };
  }

  /** The id of the caller's own vendor case in this tenant, if one is open. */
  private async ownCaseId(
    q: Db | DbTransaction,
    tenantId: string,
    partyId: string,
  ): Promise<string | undefined> {
    const [row] = await q
      .select({ id: verificationCases.id })
      .from(verificationCases)
      .where(
        and(
          eq(verificationCases.tenantId, tenantId),
          eq(verificationCases.partyId, partyId),
          eq(verificationCases.partyKind, 'vendor'),
        ),
      );
    return row?.id;
  }

  /** 404 unless the version belongs to a live document of `ownerType`/`ownerId` in this entity. */
  private async assertVersion(
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    documentId: string,
    versionId: string,
  ): Promise<void> {
    if (!Id.safeParse(documentId).success || !Id.safeParse(versionId).success) throw notFound();
    const [found] = await this.db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .innerJoin(
        documents,
        and(
          eq(documents.tenantId, documentVersions.tenantId),
          eq(documents.id, documentVersions.documentId),
        ),
      )
      .where(
        and(
          eq(documentVersions.tenantId, scope.tenantId),
          eq(documentVersions.organizationId, scope.organizationId),
          eq(documentVersions.id, versionId),
          eq(documents.organizationId, scope.organizationId),
          eq(documents.id, documentId),
          eq(documents.ownerType, ownerType),
          eq(documents.ownerId, ownerId),
          isNull(documents.removedAt),
        ),
      )
      .limit(1);
    if (found === undefined) throw notFound();
  }

  /**
   * 404 unless `documentId` is a live document of `ownerType`/`ownerId` in this entity; 409 when none of its versions
   * has received bytes yet (the PUT was not made), or the bytes were refused; 409 document_infected when the scan
   * found a virus in it (TR-Q12e).
   */
  private async assertDocument(
    tx: DbTransaction,
    scope: TxScope,
    ownerType: string,
    ownerId: string,
    documentId: string,
  ): Promise<void> {
    const [doc] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, scope.tenantId),
          eq(documents.organizationId, scope.organizationId),
          eq(documents.id, documentId),
          eq(documents.ownerType, ownerType),
          eq(documents.ownerId, ownerId),
          isNull(documents.removedAt),
        ),
      );
    if (doc === undefined) throw notFound();
    // Before the received check, so a file the scan refused says why rather than "wait".
    await assertNotInfected(tx, scope, [documentId]);
    const [received] = await tx
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.tenantId, scope.tenantId),
          eq(documentVersions.documentId, documentId),
          inArray(documentVersions.status, [...RECEIVED_STATUSES]),
        ),
      )
      .limit(1);
    if (received === undefined) {
      throw new ConflictException({
        code: 'conflict',
        message: 'Upload the file and wait for it to be accepted before submitting it',
      });
    }
  }
}
