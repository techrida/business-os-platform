// HTTP route of the staff PDF download of a quotation version. Thin on purpose: the ids are parsed here, every rule
// is in QuotationDocumentService. The route needs quotation.read (route level); the service then reads the version
// in the caller's entity and `own`/`department` scope, the same rule as the drafting reads.
import type { SignedLinkDto } from '@bos/contracts';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { QuotationDocumentService } from './quotation-document.service';

@Controller('v1/quotations')
export class QuotationDocumentController {
  constructor(private readonly documents: QuotationDocumentService) {}

  /**
   * 200 with a SignedLinkDto: a short-lived, single-use link to the rendered PDF, redeemed at GET /v1/files/:token.
   * Every call issues a new link. 403 for a portal caller; 404 for a version outside the caller's entity or scope,
   * or of another quotation; 409 `quotation_pdf_not_ready` while the version has no rendered PDF or it has not
   * scanned clean.
   */
  @Get(':id/versions/:vid/document')
  @Can('quotation.read')
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) versionId: string,
  ): Promise<SignedLinkDto> {
    return this.documents.link(id, versionId);
  }
}
