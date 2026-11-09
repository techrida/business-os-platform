// HTTP route of the staff PDF download of an issued invoice (P3 unit U11). Thin on purpose: the id is parsed here,
// every rule is in InvoiceDocumentService. Needs invoice.read at route level; the service then reads the invoice in the
// caller's entity and read scope. It is its own controller on the same `v1/invoices` prefix as InvoicesController
// (U10); its path `:id/document` cannot clash with `:id`.
import type { SignedLinkDto } from '@bos/contracts';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { InvoiceDocumentService } from './invoice-document.service';

@Controller('v1/invoices')
export class InvoiceDocumentController {
  constructor(private readonly documents: InvoiceDocumentService) {}

  /**
   * 200 with a SignedLinkDto: a short-lived, single-use link to the clean PDF, redeemed at GET /v1/files/:token.
   * Every call issues a new link. 403 for a portal caller; 404 for a draft, an invoice outside the caller's entity or
   * scope, a random id, or an issued invoice whose PDF is not rendered and scanned clean yet.
   */
  @Get(':id/document')
  @Can('invoice.read')
  link(@Param('id', ParseUUIDPipe) id: string): Promise<SignedLinkDto> {
    return this.documents.link(id);
  }
}
