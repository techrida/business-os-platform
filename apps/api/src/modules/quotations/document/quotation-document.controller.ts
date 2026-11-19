// HTTP routes of the staff PDF of a quotation version: the download link and the retry of a failed render. Thin on
// purpose: the ids are parsed here, every rule is in QuotationDocumentService. The link needs quotation.read (route
// level); the retry needs quotation.send, the permission of the other action that acts on the PDF. The service then
// reads the version in the caller's entity and `own`/`department` scope, the same rule as the drafting reads.
import type { SignedLinkDto } from '@bos/contracts';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { QuotationDocumentService, type QuotationPdfRetryDto } from './quotation-document.service';

@Controller('v1/quotations')
export class QuotationDocumentController {
  constructor(private readonly documents: QuotationDocumentService) {}

  /**
   * 200 with a SignedLinkDto: a short-lived, single-use link to the rendered PDF, redeemed at GET /v1/files/:token.
   * Every call issues a new link. 403 for a portal caller; 404 `not_found` for a version outside the caller's
   * entity or scope, or of another quotation; 409 `quotation_pdf_not_ready` while the PDF is not rendered yet or
   * awaits its scan; 424 `quotation_pdf_failed` when the render failed (see the retry route); 404
   * `quotation_pdf_unavailable` when the file was removed or its upload is infected, rejected or failed the scan.
   */
  @Get(':id/versions/:vid/document')
  @Can('quotation.read')
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) versionId: string,
  ): Promise<SignedLinkDto> {
    return this.documents.link(id, versionId);
  }

  /**
   * 202 with `{ state: 'queued' }`: the failed render is back in the queue and the render job takes it on its next
   * pass. 403 for a portal caller; 404 for a version outside the caller's entity or scope; 409
   * `quotation_pdf_retry_not_needed` unless the render has failed (so a second click is refused harmlessly).
   */
  @Post(':id/versions/:vid/document/retry')
  @HttpCode(202)
  @Can('quotation.send')
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vid', ParseUUIDPipe) versionId: string,
  ): Promise<QuotationPdfRetryDto> {
    return this.documents.retry(id, versionId);
  }
}
