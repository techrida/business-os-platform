// HTTP route of the staff PDF download of one issued purchase order version (P4 unit P3b). Thin on purpose: the ids are
// parsed here, every rule is in PurchaseOrderDocumentService. The download is open to whoever may read the order
// (F1-Q52): @AnyAuthenticated, and the service decides like the other purchase order reads (po-read-access.ts), then
// reads the version in the caller's entity. It is its own controller on the
// same `v1/procurement/purchase-orders` prefix as PurchaseOrdersController; its path cannot clash with `:id/versions`.
// The Retry of a given-up render (round 4, R4c2) needs the same procurement.po.issue: issuing triggers the render.
import type { SignedLinkDto } from '@bos/contracts';
import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { AnyAuthenticated, Can } from '../../../../platform/authz/decorators';
import {
  PurchaseOrderDocumentService,
  type PurchaseOrderPdfRetryDto,
} from './purchase-order-document.service';

@Controller('v1/procurement/purchase-orders')
export class PurchaseOrderDocumentController {
  constructor(private readonly documents: PurchaseOrderDocumentService) {}

  /**
   * 200 with a SignedLinkDto: a short-lived, single-use link to the clean PDF, redeemed at GET /v1/files/:token.
   * Every call issues a new link. 403 for a portal caller and for staff with no grant that opens purchase orders; 404 `not_found` for a version outside the caller's entity
   * or a random id; 409 `purchase_order_pdf_not_ready` while the PDF is being prepared; 424 `purchase_order_pdf_failed`
   * once its render was given up; 404 `purchase_order_pdf_scan_refused` when the virus scan refused it, 404
   * `purchase_order_pdf_unavailable` when it went away before the link was issued.
   */
  @Get(':id/versions/:version/document')
  @AnyAuthenticated()
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<SignedLinkDto> {
    return this.documents.link(id, version);
  }

  /**
   * 202 `{ state: 'queued' }`: the given-up render of this version starts a fresh set of tries on the next sweep. 409
   * `purchase_order_pdf_retry_not_needed` when it was not given up; 404 as for the link.
   */
  @Post(':id/versions/:version/document/retry')
  @HttpCode(202)
  @Can('procurement.po.issue')
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ): Promise<PurchaseOrderPdfRetryDto> {
    return this.documents.retry(id, version);
  }
}
