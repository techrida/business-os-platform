// PurchaseOrderDocumentService: a staff member downloads the rendered PDF of one issued version of a purchase order
// (P4 unit P3b). Serves the NFRs:
// - "a file is served only after a clean scan": the link comes from DocumentsService.issueLinkForOwner, which refuses
//   unless the newest upload of the document is `clean`;
// - "one legal entity at a time": the version is read scoped to the acting entity, so another entity's PO is a 404
//   rather than a 403;
// - every refusal that is not about who is asking is the same 404, so the route never says whether the version, its
//   PDF or its scan was the reason.
// Staff only: a vendor reads through the vendor portal API, which asks the same documents module with its own checks.
import type { SignedLinkDto } from '@bos/contracts';
import { documents, documentVersions, purchaseOrderVersions, scoped } from '@bos/db';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { DB, type Db } from '../../../../platform/db/db.module';
import { withTx } from '../../../../platform/db/tx';
import { DocumentsService } from '../../../../platform/documents/documents.service';
import { PurchaseOrdersCaller } from '../purchase-orders.caller';
import { PO_VERSION_OWNER_TYPE } from './purchase-order-version-owner.policy';

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Purchase order document not found' });

/** The largest value of an integer column; a version number above it cannot exist, and must not reach the query. */
const MAX_VERSION = 2_147_483_647;

@Injectable()
export class PurchaseOrderDocumentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly caller: PurchaseOrdersCaller,
  ) {}

  /**
   * A signed link to the clean PDF of version `version` of one purchase order. 403 for a portal caller; 404 for
   * anything else that is not a clean PDF of a version in the caller's entity.
   */
  async link(purchaseOrderId: string, version: number): Promise<SignedLinkDto> {
    const { scope, actor, principal } = this.caller.current();
    if (principal.orgKind !== 'staff') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) throw notFound();
    const found = await withTx(this.db, scope, actor, async (tx) => {
      const s = scoped(scope);
      const [row] = await tx
        .select({ id: purchaseOrderVersions.id })
        .from(purchaseOrderVersions)
        .where(
          s.where(
            purchaseOrderVersions,
            and(
              eq(purchaseOrderVersions.purchaseOrderId, purchaseOrderId),
              eq(purchaseOrderVersions.version, version),
            ),
          ),
        )
        .limit(1);
      if (row === undefined) return undefined;
      const [doc] = await tx
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(
          documentVersions,
          and(
            eq(documentVersions.tenantId, documents.tenantId),
            eq(documentVersions.documentId, documents.id),
          ),
        )
        .where(
          s.where(
            documents,
            and(
              eq(documents.ownerType, PO_VERSION_OWNER_TYPE),
              eq(documents.ownerId, row.id),
              isNull(documents.removedAt),
              eq(documentVersions.status, 'clean'),
            ),
          ),
        )
        .orderBy(asc(documents.createdAt))
        .limit(1);
      return doc === undefined ? undefined : { versionId: row.id, documentId: doc.id };
    });
    if (found === undefined) throw notFound();
    try {
      return await this.documents.issueLinkForOwner(
        scope,
        { ownerType: PO_VERSION_OWNER_TYPE, ownerId: found.versionId },
        found.documentId,
      );
    } catch (error) {
      // issueLinkForOwner answers one 404 for every refusal (a newer version that is not clean, say).
      if (error instanceof NotFoundException) throw notFound();
      throw error;
    }
  }
}
