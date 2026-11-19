// Staff uploads of a bank account's call-back evidence (P4 V2b, AD9). Procurement (`vendor.bank.propose`) or finance
// (`vendor.bank.verify`), no `documents.upload` needed, attaches the proof of the call-back to a proposed account;
// finance verifies with it. A caller holding neither grant is refused (403) before anything is read, as `@Can` would.
// That the proposer never verifies is BankService.verify's rule, unchanged.
// Two steps, like P3's staff payment proofs: POST declares the file and returns `uploadPath`, then a raw PUT of the
// bytes to that path, sent with the file's own Content-Type.
// Serves the NFRs "deny by default" and "no unscanned file is ever served": every step goes through DocumentsService
// (the evidence owner policy's upload permission and "only while proposed" rule, the type and size limits,
// quarantine and the virus scan are unchanged), and nothing here widens `documents.upload`. The account must be
// one of the vendor's in this tenant, and a PUT must name a live evidence document of that account in the acting
// entity; anything else (another tenant, another vendor or account, another entity, a bad id) is the same 404.
import type { Readable } from 'node:stream';

import { CreateDocumentBodySchema, type DocumentVersionDto } from '@bos/contracts';
import { documents, documentVersions, vendorBankAccounts } from '@bos/db';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { can, type Principal } from '../../../platform/authz/can';
import { DB, type Db } from '../../../platform/db/db.module';
import { withTx, type TxScope } from '../../../platform/db/tx';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { VendorsCaller } from '../vendors.caller';
import { BANK_EVIDENCE_UPLOAD_PERMISSIONS } from './bank-evidence.policy';
import { BANK_EVIDENCE_OWNER_TYPE } from './bank.rules';

const Id = z.guid();

/** What the client declares about the file. The owner is the account in the path, never the body. */
export const BankEvidenceFileSchema = CreateDocumentBodySchema.pick({
  filename: true,
  declaredMime: true,
  sizeBytes: true,
});

export interface CreatedBankEvidence {
  documentId: string;
  versionId: string;
  uploadPath: string;
}

export const bankEvidenceUploadPath = (
  vendorId: string,
  accountId: string,
  documentId: string,
  versionId: string,
): string =>
  `/v1/vendors/${vendorId}/bank-accounts/${accountId}/evidence/${documentId}/versions/${versionId}/content`;

const evidenceNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Bank account evidence not found' });
const accountNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Bank account not found' });
const forbidden = () =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });

/** Staff holding either upload grant at any scope, as a route-level `@Can` would check one of them. */
function assertAttacher(p: Principal): void {
  if (p.orgKind !== 'staff') throw forbidden();
  if (!BANK_EVIDENCE_UPLOAD_PERMISSIONS.some((action) => can(p, action).allowed)) throw forbidden();
}

/** Field names only: echoing values back would reflect attacker-controlled text. */
function invalidFile(error: z.ZodError): BadRequestException {
  const fields = [...new Set(error.issues.map((i) => i.path.join('.') || 'body'))];
  return new BadRequestException(`Invalid evidence file: ${fields.join(', ')}`);
}

@Injectable()
export class VendorBankEvidenceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: VendorsCaller,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * The route-level check the routes cannot declare with one `@Can`: 403 unless the caller is staff holding
   * `vendor.bank.propose` or `vendor.bank.verify` (the grant alone; the vendor's scope is DocumentsService's check).
   * The controller calls it before it reads the request, so a caller without either learns nothing else.
   */
  assertMayAttach(): void {
    assertAttacher(this.caller.current().principal);
  }

  /**
   * Creates the evidence document (version 1, awaiting_content) on the account. DocumentsService checks
   * `vendor.bank.propose` or `vendor.bank.verify` on the vendor (403) and that the account is still proposed (409).
   */
  async create(vendorId: string, accountId: string, body: unknown): Promise<CreatedBankEvidence> {
    const { scope, actor, principal } = this.caller.current();
    assertAttacher(principal);
    const parsed = BankEvidenceFileSchema.safeParse(body);
    if (!parsed.success) throw invalidFile(parsed.error);
    await this.assertAccount(scope, vendorId, accountId);
    const created = await withTx(this.db, scope, actor, (tx) =>
      this.documents.create(tx, {
        ownerType: BANK_EVIDENCE_OWNER_TYPE,
        ownerId: accountId,
        ...parsed.data,
      }),
    );
    return {
      ...created,
      uploadPath: bankEvidenceUploadPath(
        vendorId,
        accountId,
        created.documentId,
        created.versionId,
      ),
    };
  }

  /**
   * Streams the bytes of an evidence version into the documents pipeline (quarantine, type check, scan queued).
   * DocumentsService checks the upload permission and "still proposed" again inside its transaction.
   */
  async receive(
    vendorId: string,
    accountId: string,
    documentId: string,
    versionId: string,
    src: Readable,
    contentLength: number,
  ): Promise<DocumentVersionDto> {
    const { scope, actor, principal } = this.caller.current();
    assertAttacher(principal);
    if (!Id.safeParse(documentId).success || !Id.safeParse(versionId).success) {
      throw evidenceNotFound();
    }
    await this.assertAccount(scope, vendorId, accountId);
    await this.assertEvidenceVersion(scope, accountId, documentId, versionId);
    return this.documents.receiveContent(versionId, src, contentLength, {
      documentId,
      who: { scope, actor },
    });
  }

  /** 404 unless the account is one of the vendor's in this tenant (both are tenant-level, 0032). */
  private async assertAccount(scope: TxScope, vendorId: string, accountId: string): Promise<void> {
    const [found] = await this.db
      .select({ id: vendorBankAccounts.id })
      .from(vendorBankAccounts)
      .where(
        and(
          eq(vendorBankAccounts.tenantId, scope.tenantId),
          eq(vendorBankAccounts.vendorId, vendorId),
          eq(vendorBankAccounts.id, accountId),
        ),
      )
      .limit(1);
    if (found === undefined) throw accountNotFound();
  }

  /** 404 unless the version belongs to a live evidence document of the account in the acting entity. */
  private async assertEvidenceVersion(
    scope: TxScope,
    accountId: string,
    documentId: string,
    versionId: string,
  ): Promise<void> {
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
          eq(documents.ownerType, BANK_EVIDENCE_OWNER_TYPE),
          eq(documents.ownerId, accountId),
          isNull(documents.removedAt),
        ),
      )
      .limit(1);
    if (found === undefined) throw evidenceNotFound();
  }
}
