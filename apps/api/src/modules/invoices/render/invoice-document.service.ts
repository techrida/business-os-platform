// InvoiceDocumentService: a staff member downloads the rendered PDF of an issued invoice (P3 unit U11). Serves the NFRs:
// - "a file is served only after a clean scan": the link comes from DocumentsService.issueLinkForOwner, which refuses
//   unless the newest upload of the document is `clean`;
// - "authorization is deny-by-default" and "one legal entity at a time": the invoice is read under the same
//   scopeWhereFor('invoice.read') rule as the drafting reads, so another entity's invoice is a 404 rather than a 403;
// - "a draft is not a document": only an issued invoice has a PDF, and every refusal is the same 404, so the route
//   never says whether a draft, a missing PDF or a foreign invoice was the reason.
// Staff only: a portal caller reads through the portal API (U13).
import type { SignedLinkDto } from '@bos/contracts';
import { documents, documentVersions, invoices, scoped } from '@bos/db';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { scopeWhereFor } from '../../../platform/authz/authz.service';
import { DB, type Db } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { INVOICE_OWNER_TYPE } from '../invoice-owner.policy';
import { assertStaff, InvoiceCaller } from '../invoice-support';

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Invoice document not found' });

@Injectable()
export class InvoiceDocumentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly caller: InvoiceCaller,
  ) {}

  /**
   * A signed link to the clean PDF of one issued invoice: the original (the oldest live document that scanned clean),
   * never a reprint while the original is there. 403 for a portal caller; 404 for anything else that is not a clean
   * PDF of an issued invoice in the caller's entity and read scope.
   */
  async link(invoiceId: string): Promise<SignedLinkDto> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    const visible = scopeWhereFor(principal, invoices, 'invoice.read');
    const documentId = await withTx(this.db, scope, actor, async (tx) => {
      const [invoice] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(visible, eq(invoices.id, invoiceId), eq(invoices.status, 'issued')))
        .limit(1);
      if (invoice === undefined) return undefined;
      const s = scoped(scope);
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
          and(
            s.where(
              documents,
              and(
                eq(documents.ownerType, INVOICE_OWNER_TYPE),
                eq(documents.ownerId, invoiceId),
                isNull(documents.removedAt),
                eq(documentVersions.status, 'clean'),
              ),
            ),
          ),
        )
        .orderBy(asc(documents.createdAt))
        .limit(1);
      return doc?.id;
    });
    if (documentId === undefined) throw notFound();
    try {
      return await this.documents.issueLinkForOwner(
        scope,
        { ownerType: INVOICE_OWNER_TYPE, ownerId: invoiceId },
        documentId,
      );
    } catch (error) {
      // issueLinkForOwner answers one 404 for every refusal (a newer version that is not clean, say).
      if (error instanceof NotFoundException) throw notFound();
      throw error;
    }
  }
}
