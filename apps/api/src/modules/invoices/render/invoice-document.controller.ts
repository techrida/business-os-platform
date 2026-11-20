// HTTP routes of the staff PDF of an issued invoice: the download link (P3 unit U11) and the retry of a render that was
// given up (round 4, R4c2). Thin on purpose: the id is parsed here, every rule is in InvoiceDocumentService. The link
// needs invoice.read at route level; the retry needs invoice.issue, the permission of the action that triggers the
// render. The service then reads the invoice in the caller's entity and scope for that same permission. It is its own
// controller on the same `v1/invoices` prefix as InvoicesController (U10); its paths under `:id/document` cannot clash
// with `:id`.
import type { SignedLinkDto } from '@bos/contracts';
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Can } from '../../../platform/authz/decorators';
import { InvoiceDocumentService, type InvoicePdfRetryDto } from './invoice-document.service';

@Controller('v1/invoices')
export class InvoiceDocumentController {
  constructor(private readonly documents: InvoiceDocumentService) {}

  /**
   * 200 with a SignedLinkDto: a short-lived, single-use link to the clean PDF, redeemed at GET /v1/files/:token.
   * Every call issues a new link. 403 for a portal caller; 404 `not_found` for a draft, an invoice outside the
   * caller's entity or scope, or a random id; 409 `invoice_pdf_not_ready` while the PDF is being prepared; 424
   * `invoice_pdf_failed` when its render was given up (see the retry route); 404 `invoice_pdf_unavailable` when the
   * scan refused the file.
   */
  @Get(':id/document')
  @Can('invoice.read')
  link(@Param('id', ParseUUIDPipe) id: string): Promise<SignedLinkDto> {
    return this.documents.link(id);
  }

  /**
   * 202 with `{ state: 'queued' }`: the render that was given up starts again on the render job's next pass. 403 for
   * a portal caller; 404 for an invoice outside the caller's entity or `invoice.issue` scope; 409
   * `invoice_pdf_retry_not_needed` unless the render was given up (so a second click is refused harmlessly).
   */
  @Post(':id/document/retry')
  @HttpCode(202)
  @Can('invoice.issue')
  retry(@Param('id', ParseUUIDPipe) id: string): Promise<InvoicePdfRetryDto> {
    return this.documents.retry(id);
  }
}
