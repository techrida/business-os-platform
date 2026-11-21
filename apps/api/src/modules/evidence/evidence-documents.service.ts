// Evidence uploads in place (round 5 P2): the staff routes that create an `evidence` document on a sales order, a
// vendor bill or an RFQ and receive its bytes. They exist because the generic upload routes need
// `documents.upload`, which the Accountant and Finance (who mark lines billable and enter bills) do not hold. Each
// route names its record kind's own permission, refuses an id of another kind or entity (404) and then hands over
// to DocumentsService, which checks the record's upload grants (evidence-owner.policy.ts), its attach rule, the
// type and size, and queues the virus scan like every other upload.
import type { Readable } from 'node:stream';

import { CreateDocumentBodySchema, type DocumentVersionDto } from '@bos/contracts';
import { documents, documentVersions } from '@bos/db';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { DB, type Db } from '../../platform/db/db.module';
import { withTx } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { EVIDENCE_OWNER_TYPE } from '../../platform/documents/evidence-document';
import { EvidenceCaller } from './evidence.caller';
import { type EvidenceRecordKind, type EvidenceRecordLoader } from './evidence-owner.policy';

/** Injection token of the record loader, so tests and the registrar share one. */
export const EVIDENCE_RECORD_LOADER = Symbol('EVIDENCE_RECORD_LOADER');

const Id = z.guid();
const FileSchema = CreateDocumentBodySchema.pick({
  filename: true,
  declaredMime: true,
  sizeBytes: true,
});

/** Where each kind's routes live: the record's own path, so the route sits beside the action it serves. */
export const EVIDENCE_ROUTE_BASE: Record<EvidenceRecordKind, string> = {
  sales_order: '/v1/sales-orders',
  vendor_bill: '/v1/payables/bills',
  rfq: '/v1/procurement/rfqs',
};

export interface CreatedEvidenceDocument {
  documentId: string;
  versionId: string;
  uploadPath: string;
}

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Record not found' });
const fileNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Evidence file not found' });
const forbidden = () =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });

export function evidenceUploadPath(
  kind: EvidenceRecordKind,
  recordId: string,
  documentId: string,
  versionId: string,
): string {
  return `${EVIDENCE_ROUTE_BASE[kind]}/${recordId}/evidence-documents/${documentId}/versions/${versionId}/content`;
}

@Injectable()
export class EvidenceDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EVIDENCE_RECORD_LOADER) private readonly load: EvidenceRecordLoader,
    private readonly caller: EvidenceCaller,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * Creates the evidence document and its version 1 on the record (owner id = the record id). 404 for an id that is
   * not a record of this kind in the acting entity; 403 without the kind's grant on that record; 409 when the
   * record no longer takes evidence; 415 or 413 for the type or size.
   */
  async create(
    kind: EvidenceRecordKind,
    recordId: string,
    body: unknown,
  ): Promise<CreatedEvidenceDocument> {
    const { scope, actor } = this.staffCaller();
    if (!Id.safeParse(recordId).success) throw notFound();
    const parsed = FileSchema.safeParse(body);
    if (!parsed.success) {
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'body')),
      ];
      throw new BadRequestException(`Invalid evidence file: ${fields.join(', ')}`);
    }
    const created = await withTx(this.db, scope, actor, async (tx) => {
      const record = await this.load(scope, recordId);
      if (record?.kind !== kind) throw notFound();
      return this.documents.create(tx, {
        ownerType: EVIDENCE_OWNER_TYPE,
        ownerId: recordId,
        ...parsed.data,
      });
    });
    return {
      documentId: created.documentId,
      versionId: created.versionId,
      uploadPath: evidenceUploadPath(kind, recordId, created.documentId, created.versionId),
    };
  }

  /**
   * Receives the bytes of a version of a live evidence document of this record. 404 when the version is not one,
   * or the record is not of this kind in the acting entity. DocumentsService re-checks the grant and the attach
   * rule, then quarantines the bytes and queues the scan.
   */
  async receive(
    kind: EvidenceRecordKind,
    recordId: string,
    documentId: string,
    versionId: string,
    src: Readable,
    contentLength: number,
  ): Promise<DocumentVersionDto> {
    const { scope, actor } = this.staffCaller();
    if (![recordId, documentId, versionId].every((id) => Id.safeParse(id).success)) {
      throw fileNotFound();
    }
    const record = await this.load(scope, recordId);
    if (record?.kind !== kind) throw fileNotFound();
    const [found] = await this.db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .innerJoin(
        documents,
        and(
          eq(documents.tenantId, documentVersions.tenantId),
          eq(documents.organizationId, documentVersions.organizationId),
          eq(documents.id, documentVersions.documentId),
        ),
      )
      .where(
        and(
          eq(documentVersions.tenantId, scope.tenantId),
          eq(documentVersions.organizationId, scope.organizationId),
          eq(documentVersions.id, versionId),
          eq(documents.id, documentId),
          eq(documents.ownerType, EVIDENCE_OWNER_TYPE),
          eq(documents.ownerId, recordId),
          isNull(documents.removedAt),
        ),
      )
      .limit(1);
    if (found === undefined) throw fileNotFound();
    return this.documents.receiveContent(versionId, src, contentLength, {
      documentId,
      who: { scope, actor },
    });
  }

  /** Evidence is a staff surface; a portal caller learns nothing about the record. */
  private staffCaller() {
    const info = this.caller.current();
    if (info.principal.orgKind !== 'staff') throw forbidden();
    return info;
  }
}
