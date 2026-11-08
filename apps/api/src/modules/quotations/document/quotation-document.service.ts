// QuotationDocumentService: a staff member downloads the rendered PDF of a quotation version. Serves the NFRs:
// - "a file is served only after a clean scan": the link comes from DocumentsService.issueLinkForOwner, which
//   refuses unless the newest upload of the document is `clean`; a version without a rendered document, or with
//   one that is not clean, is a 409 `quotation_pdf_not_ready`;
// - "authorization is deny-by-default" and "one legal entity at a time": the version is read in the caller's entity
//   under the same scopeWhereFor('quotation.read') rule as the drafting reads, so another entity's version, or
//   another owner's under `own` scope, is a 404 rather than a 403 that would confirm it exists;
// - staff only: a version carries internal cost, so a portal caller is refused here (the portal has its own route).
import { quotations, quotationVersions } from '@bos/db';
import type { SignedLinkDto } from '@bos/contracts';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { scopeWhereFor } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { DraftingCaller } from '../drafting/drafting.caller';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';

/** What the link needs of a version: the entity it lives in and its rendered document, null when none. */
export interface QuotationDocumentHead {
  tenantId: string;
  organizationId: string;
  renderedDocumentId: string | null;
}

const versionNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Quotation version not found' });
const notReady = () =>
  new ConflictException({
    code: 'quotation_pdf_not_ready',
    message: 'The PDF of this quotation version is not ready to download',
  });

/** The database read of the download, apart from the service so its unit test needs no Postgres. */
@Injectable()
export class QuotationDocumentStore {
  /**
   * The version, when `p` may read its quotation and the version belongs to it; undefined otherwise. The quotation
   * is read through scopeWhereFor, the SQL twin of can(), so the entity and the `own` scope apply as in the list.
   */
  async head(
    tx: DbTransaction,
    p: Principal,
    quotationId: string,
    versionId: string,
  ): Promise<QuotationDocumentHead | undefined> {
    const [row] = await tx
      .select({
        tenantId: quotationVersions.tenantId,
        organizationId: quotationVersions.organizationId,
        renderedDocumentId: quotationVersions.renderedDocumentId,
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
        and(
          scopeWhereFor(p, quotations, 'quotation.read'),
          eq(quotations.id, quotationId),
          eq(quotationVersions.id, versionId),
        ),
      )
      .limit(1);
    return row;
  }
}

@Injectable()
export class QuotationDocumentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly store: QuotationDocumentStore,
    private readonly caller: DraftingCaller,
  ) {}

  /**
   * A signed link to the rendered PDF of one version. 403 for a portal caller, 404 when the version is not in the
   * caller's read scope or not of that quotation, 409 `quotation_pdf_not_ready` without a clean rendered PDF.
   * The link is issued after the read transaction closes, in the version's own entity.
   */
  async link(quotationId: string, versionId: string): Promise<SignedLinkDto> {
    const { scope, actor, principal } = this.caller.current();
    if (principal.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    const head = await withTx(this.db, scope, actor, (tx) =>
      this.store.head(tx, principal, quotationId, versionId),
    );
    if (head === undefined) throw versionNotFound();
    if (head.renderedDocumentId === null) throw notReady();
    try {
      return await this.documents.issueLinkForOwner(
        { tenantId: head.tenantId, organizationId: head.organizationId },
        { ownerType: QUOTATION_OWNER_TYPE, ownerId: versionId },
        head.renderedDocumentId,
      );
    } catch (error) {
      // issueLinkForOwner answers one 404 for every refusal; here the version is already known to be the caller's,
      // so that refusal means the file is not (yet) clean.
      if (error instanceof NotFoundException) throw notReady();
      throw error;
    }
  }
}
