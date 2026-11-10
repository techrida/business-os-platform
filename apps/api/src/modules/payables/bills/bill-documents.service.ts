// Staff invoice uploads use the bill-entry grant and the documents kernel's quarantine and scan pipeline.
import type { Readable } from 'node:stream';

import { CreateDocumentBodySchema, type DocumentVersionDto } from '@bos/contracts';
import { documents, documentVersions, scoped, vendorAccounts, vendorBills, vendors } from '@bos/db';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withTx, type TxScope } from '../../../platform/db/tx';
import type { DocumentOwnerPolicy } from '../../../platform/documents/documents.ports';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { VendorBillsCaller } from './vendor-bills.caller';

const OWNER_TYPE = 'vendor_bill_intake';
const Id = z.guid();
const FileSchema = CreateDocumentBodySchema.pick({
  filename: true,
  declaredMime: true,
  sizeBytes: true,
}).extend({ vendorPartyId: Id });
const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Bill invoice file not found' });
const forbidden = () =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });

export interface CreatedBillDocument {
  documentId: string;
  versionId: string;
  uploadPath: string;
}

/** An intake belongs to an active vendor account in the acting entity; no portal or system upload hook. */
export function billDocumentOwnerPolicy(db: Db): DocumentOwnerPolicy {
  const load = async (scope: TxScope, vendorId: string, tx?: DbTransaction) => {
    if (!Id.safeParse(vendorId).success) return undefined;
    const query = (tx ?? db)
      .select({ vendorId: vendors.id, ownerUserId: vendors.ownerUserId })
      .from(vendorAccounts)
      .innerJoin(
        vendors,
        and(eq(vendors.tenantId, vendorAccounts.tenantId), eq(vendors.id, vendorAccounts.vendorId)),
      )
      .where(
        and(
          eq(vendorAccounts.tenantId, scope.tenantId),
          eq(vendorAccounts.organizationId, scope.organizationId),
          eq(vendorAccounts.vendorId, vendorId),
          eq(vendorAccounts.active, true),
        ),
      );
    const [row] = tx === undefined ? await query : await query.for('share');
    return row;
  };
  return {
    ownerType: OWNER_TYPE,
    uploadPermission: 'payables.bill.enter',
    resource: async (scope, vendorId) => {
      const row = await load(scope, vendorId);
      if (row === undefined) return null;
      return { ...scope, ownerUserId: row.ownerUserId, vendorPartyId: row.vendorId };
    },
    canAttach: async (scope, vendorId, tx, documentId) => {
      if ((await load(scope, vendorId, tx)) === undefined) return false;
      if (documentId === undefined) return true;
      const query = (tx ?? db)
        .select({ status: vendorBills.status })
        .from(vendorBills)
        .where(scoped(scope).where(vendorBills, eq(vendorBills.documentId, documentId)));
      const bills = tx === undefined ? await query : await query.for('share');
      return bills.every((bill) => bill.status === 'draft' || bill.status === 'discarded');
    },
  };
}

@Injectable()
export class BillDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: VendorBillsCaller,
    private readonly documents: DocumentsService,
  ) {}

  async create(body: unknown): Promise<CreatedBillDocument> {
    const { scope, actor, principal } = this.caller.current();
    if (principal.orgKind !== 'staff') throw forbidden();
    const parsed = FileSchema.safeParse(body);
    if (!parsed.success) {
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'body')),
      ];
      throw new BadRequestException(`Invalid invoice file: ${fields.join(', ')}`);
    }
    const { vendorPartyId, ...file } = parsed.data;
    const created = await withTx(this.db, scope, actor, (tx) =>
      this.documents.create(tx, { ownerType: OWNER_TYPE, ownerId: vendorPartyId, ...file }),
    );
    return {
      ...created,
      uploadPath: `/v1/payables/bill-documents/${created.documentId}/versions/${created.versionId}/content`,
    };
  }

  async receive(
    documentId: string,
    versionId: string,
    src: Readable,
    contentLength: number,
  ): Promise<DocumentVersionDto> {
    const { scope, actor, principal } = this.caller.current();
    if (principal.orgKind !== 'staff') throw forbidden();
    if (!Id.safeParse(documentId).success || !Id.safeParse(versionId).success) throw notFound();
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
      .innerJoin(
        vendorAccounts,
        and(
          eq(vendorAccounts.tenantId, documents.tenantId),
          eq(vendorAccounts.organizationId, documents.organizationId),
          eq(vendorAccounts.vendorId, documents.ownerId),
          eq(vendorAccounts.active, true),
        ),
      )
      .where(
        and(
          eq(documentVersions.tenantId, scope.tenantId),
          eq(documentVersions.organizationId, scope.organizationId),
          eq(documentVersions.id, versionId),
          eq(documents.id, documentId),
          eq(documents.ownerType, OWNER_TYPE),
          isNull(documents.removedAt),
        ),
      )
      .limit(1);
    if (found === undefined) throw notFound();
    return this.documents.receiveContent(versionId, src, contentLength, {
      documentId,
      who: { scope, actor },
    });
  }

  async createVersion(documentId: string, body: unknown): Promise<CreatedBillDocument> {
    const { scope, actor, principal } = this.caller.current();
    if (principal.orgKind !== 'staff') throw forbidden();
    if (!Id.safeParse(documentId).success) throw notFound();
    const parsed = FileSchema.omit({ vendorPartyId: true }).safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invoice file');
    const created = await withTx(this.db, scope, actor, async (tx) => {
      const [doc] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          scoped(scope).where(
            documents,
            and(
              eq(documents.id, documentId),
              eq(documents.ownerType, OWNER_TYPE),
              isNull(documents.removedAt),
            ),
          ),
        );
      if (doc === undefined) throw notFound();
      return this.documents.createVersion(tx, documentId, parsed.data);
    });
    return {
      ...created,
      uploadPath: `/v1/payables/bill-documents/${documentId}/versions/${created.versionId}/content`,
    };
  }
}
