// HTTP route of the staff PDF download of one issued purchase order version (P4 unit P3b). Thin on purpose: the ids are
// parsed here, every rule is in PurchaseOrderDocumentService. Needs procurement.po.issue at route level, like the other
// purchase order reads; the service then reads the version in the caller's entity. It is its own controller on the
// same `v1/procurement/purchase-orders` prefix as PurchaseOrdersController; its path cannot clash with `:id/versions`.
import type { SignedLinkDto } from '@bos/contracts';
import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe } from '@nestjs/common';

import { Can } from '../../../../platform/authz/decorators';
import { PurchaseOrderDocumentService } from './purchase-order-document.service';

@Controller('v1/procurement/purchase-orders')
export class PurchaseOrderDocumentController {
  constructor(private readonly documents: PurchaseOrderDocumentService) {}

  /**
   * 200 with a SignedLinkDto: a short-lived, single-use link to the clean PDF, redeemed at GET /v1/files/:token.
   * Every call issues a new link. 403 for a portal caller; 404 for a version outside the caller's entity, a random
   * id, or a version whose PDF is not rendered and scanned clean yet.
   */
  @Get(':id/versions/:version/document')
  @Can('procurement.po.issue')
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<SignedLinkDto> {
    return this.documents.link(id, version);
  }
}
