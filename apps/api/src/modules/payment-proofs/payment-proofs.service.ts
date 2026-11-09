// Payment-proof uploads (P3 U13 part 2): a bank slip uploaded before the payment exists, under the documents owner
// type `payment_intake` (owner id = the customer party), so PaymentsService.submit can link it by id.
// Serves the NFR "deny by default" and "no unscanned file is ever served": every step goes through DocumentsService
// (the owner policy's `allowsCounterparty`, the type and size limits, quarantine and the virus scan are unchanged),
// and nothing here widens `documents.upload`.
//
// Portal: the owner id is always the caller's own party, never a value from the body. A PUT names a document and a
// version; anything that is not a live `payment_intake` document of the caller's party in this entity (a bad id, a
// missing one, another party's) is the same 404, checked before DocumentsService is asked, so a stranger never sees
// the 403 the grant check would give and learns nothing about whether the id exists.
//
// Staff: whoever records payments (`payment.record`, for example the Accountant, who holds no `documents.upload`)
// uploads proof for a customer named in the body. The intake owner policy names `payment.record` as its upload
// permission, so DocumentsService checks that grant on the customer, nothing wider. A `customerId` that is not a
// customer party of the tenant, and a PUT naming anything but a live `payment_intake` document of this entity, are
// the same 404 as the portal's.
import type { Readable } from 'node:stream';

import { CreateDocumentBodySchema, type DocumentVersionDto } from '@bos/contracts';
import { documents, documentVersions, parties } from '@bos/db';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Principal } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { PAYMENT_INTAKE_OWNER_TYPE } from '../payments/payment-owner.policy';
import { assertCustomerCaller } from '../portal/portal.caller';

const Id = z.guid();

/** What the client declares about the file. The owner is decided here, never by the body. */
export const PaymentProofFileSchema = CreateDocumentBodySchema.pick({
  filename: true,
  declaredMime: true,
  sizeBytes: true,
});
export type PaymentProofFile = z.infer<typeof PaymentProofFileSchema>;

/** A staff upload names the customer the proof is for; its existence is checked, not parsed (404, not 400). */
export const StaffPaymentProofSchema = PaymentProofFileSchema.extend({
  customerId: z.string().min(1),
});

export interface CreatedPaymentProof {
  documentId: string;
  versionId: string;
  uploadPath: string;
}

/** The request's scope and actor, as `requestTx()` gives them. */
export interface ProofCaller {
  scope: TxScope;
  actor: Actor;
}

/** The one refusal of a portal PUT that names something the caller may not see. */
export const PAYMENT_PROOF_NOT_FOUND = 'Payment proof not found';

export const portalUploadPath = (documentId: string, versionId: string): string =>
  `/v1/portal/payment-proofs/${documentId}/versions/${versionId}/content`;

export const staffUploadPath = (documentId: string, versionId: string): string =>
  `/v1/payment-proofs/${documentId}/versions/${versionId}/content`;

/** 403 unless `p` is a staff principal. Same body as AuthzService.assert; the staff routes are not a portal door. */
function assertStaffCaller(p: Principal): void {
  if (p.orgKind !== 'staff') {
    throw new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
  }
}

/** Field names only: echoing values back would reflect attacker-controlled text. */
function invalidFile(error: z.ZodError): BadRequestException {
  const fields = [...new Set(error.issues.map((i) => i.path.join('.') || 'body'))];
  return new BadRequestException(`Invalid payment proof: ${fields.join(', ')}`);
}

@Injectable()
export class PaymentProofsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * Creates the proof document (version 1, awaiting_content) for the calling customer's own party. 403 for a
   * caller that is not a customer with a party (a staff founder holds `portal.payment.submit` at `all`).
   */
  async createForPortal(
    principal: Principal,
    who: ProofCaller,
    body: unknown,
  ): Promise<CreatedPaymentProof> {
    assertCustomerCaller(principal);
    const parsed = PaymentProofFileSchema.safeParse(body);
    if (!parsed.success) throw invalidFile(parsed.error);
    const partyId = principal.partyId as string;
    const created = await withTx(this.db, who.scope, who.actor, (tx) =>
      this.documents.create(tx, {
        ownerType: PAYMENT_INTAKE_OWNER_TYPE,
        ownerId: partyId,
        ...parsed.data,
      }),
    );
    return { ...created, uploadPath: portalUploadPath(created.documentId, created.versionId) };
  }

  /**
   * Streams the bytes of a proof version the calling customer created into the documents pipeline (quarantine,
   * type check, scan queued). Every id the caller may not see is the same 404.
   */
  async receiveForPortal(
    principal: Principal,
    who: ProofCaller,
    documentId: string,
    versionId: string,
    src: Readable,
    contentLength: number,
  ): Promise<DocumentVersionDto> {
    assertCustomerCaller(principal);
    await this.assertIntakeVersion(who.scope, principal.partyId as string, documentId, versionId);
    return this.documents.receiveContent(versionId, src, contentLength, { documentId, who });
  }

  /**
   * Creates the proof document (version 1, awaiting_content) for the customer named in the body. The route holds
   * `payment.record`; DocumentsService checks it again on the customer (the intake policy's upload permission).
   */
  async createForStaff(
    principal: Principal,
    who: ProofCaller,
    body: unknown,
  ): Promise<CreatedPaymentProof> {
    assertStaffCaller(principal);
    const parsed = StaffPaymentProofSchema.safeParse(body);
    if (!parsed.success) throw invalidFile(parsed.error);
    const { customerId, ...file } = parsed.data;
    await this.assertCustomer(who.scope, customerId);
    const created = await withTx(this.db, who.scope, who.actor, (tx) =>
      this.documents.create(tx, {
        ownerType: PAYMENT_INTAKE_OWNER_TYPE,
        ownerId: customerId,
        ...file,
      }),
    );
    return { ...created, uploadPath: staffUploadPath(created.documentId, created.versionId) };
  }

  /**
   * Streams the bytes of a staff-created proof version into the documents pipeline. Any id that is not a live
   * `payment_intake` document of this entity is the same 404; DocumentsService then checks `payment.record`.
   */
  async receiveForStaff(
    principal: Principal,
    who: ProofCaller,
    documentId: string,
    versionId: string,
    src: Readable,
    contentLength: number,
  ): Promise<DocumentVersionDto> {
    assertStaffCaller(principal);
    await this.assertIntakeVersion(who.scope, undefined, documentId, versionId);
    return this.documents.receiveContent(versionId, src, contentLength, { documentId, who });
  }

  /** 404 unless `customerId` is a customer party of the tenant. */
  private async assertCustomer(scope: TxScope, customerId: string): Promise<void> {
    if (!Id.safeParse(customerId).success) throw new NotFoundException(PAYMENT_PROOF_NOT_FOUND);
    const [found] = await this.db
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, scope.tenantId),
          eq(parties.id, customerId),
          eq(parties.kind, 'customer'),
        ),
      )
      .limit(1);
    if (found === undefined) throw new NotFoundException(PAYMENT_PROOF_NOT_FOUND);
  }

  /**
   * 404 unless the version belongs to a live `payment_intake` document in this entity, of `partyId` when given
   * (the portal); staff may reach any customer's intake document of the entity.
   */
  private async assertIntakeVersion(
    scope: TxScope,
    partyId: string | undefined,
    documentId: string,
    versionId: string,
  ): Promise<void> {
    if (!Id.safeParse(documentId).success || !Id.safeParse(versionId).success) {
      throw new NotFoundException(PAYMENT_PROOF_NOT_FOUND);
    }
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
          eq(documents.ownerType, PAYMENT_INTAKE_OWNER_TYPE),
          partyId === undefined ? undefined : eq(documents.ownerId, partyId),
          isNull(documents.removedAt),
        ),
      )
      .limit(1);
    if (found === undefined) throw new NotFoundException(PAYMENT_PROOF_NOT_FOUND);
  }
}
