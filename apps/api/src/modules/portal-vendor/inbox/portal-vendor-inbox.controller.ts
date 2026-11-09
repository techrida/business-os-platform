// HTTP routes of the vendor portal's inbox writes (P4 unit PV2), under /v1/portal/vendor. Thin on purpose: every rule
// is in VendorPortalInboxService. Every route needs `portal.vendor.submit` (route level; the vendor_user role holds it
// whatever the vendor's status); the service then refuses any caller that is not a vendor with a party, checks the
// vendor's status live (pending_kyc: KYC routes only, 403 on the rest) and answers one 404 for anything not the
// caller's. A file is two steps, like /v1/documents: POST `.../files` declares it and returns `uploadPath`, then a
// raw PUT of the bytes with their own Content-Type (the JSON and form parsers leave that stream untouched). The
// row-creating POSTs need an Idempotency-Key.
import type { DocumentVersionDto } from '@bos/contracts';
import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Put,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';

import { Can } from '../../../platform/authz/decorators';
import { requestTx } from '../../../platform/db/tx';
import { parseContentLength } from '../../../platform/documents/documents.controller';
import { requireIdempotencyKey } from '../../customers/customers.types';
import {
  VendorPortalInboxService,
  type CreatedPortalFile,
  type InboxReceipt,
  type KycDocumentReceipt,
} from './portal-vendor-inbox.service';

/** The request stream, refused when a body parser already consumed it (the file was sent as JSON or a form). */
function rawBody(req: Request): { src: Request; length: number } {
  const length = parseContentLength(req.headers['content-length']);
  if (req.readableEnded) {
    throw new UnsupportedMediaTypeException(
      'Send the file with its own Content-Type (for example application/pdf), not as JSON or a form',
    );
  }
  return { src: req, length };
}

@Controller('v1/portal/vendor')
export class VendorPortalInboxController {
  constructor(private readonly inbox: VendorPortalInboxService) {}

  /** `{filename, declaredMime, sizeBytes}` → `{documentId, versionId, uploadPath}` on the caller's own KYB case. */
  @Post('kyc-documents/files')
  @Can('portal.vendor.submit')
  createKycFile(@Body() body: unknown): Promise<CreatedPortalFile> {
    return this.inbox.createKycFile(requestTx(), body);
  }

  @Put('kyc-documents/files/:docId/versions/:verId/content')
  @Can('portal.vendor.submit')
  uploadKycFile(
    @Param('docId') docId: string,
    @Param('verId') verId: string,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    const { src, length } = rawBody(req);
    return this.inbox.receiveKycFile(requestTx(), docId, verId, src, length);
  }

  /** `{docType, documentId, validFrom?, validUntil?}`: puts the uploaded file on the checklist item. */
  @Post('kyc-documents')
  @Can('portal.vendor.submit')
  submitKycDocument(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<KycDocumentReceipt> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.inbox.submitKycDocument(requestTx(), body, key);
  }

  /** `{filename, declaredMime, sizeBytes}` → `{documentId, versionId, uploadPath}` owned by the caller's party. */
  @Post('quotation-submissions/files')
  @Can('portal.vendor.submit')
  createQuotationFile(@Body() body: unknown): Promise<CreatedPortalFile> {
    return this.inbox.createQuotationFile(requestTx(), body);
  }

  @Put('quotation-submissions/files/:docId/versions/:verId/content')
  @Can('portal.vendor.submit')
  uploadQuotationFile(
    @Param('docId') docId: string,
    @Param('verId') verId: string,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    const { src, length } = rawBody(req);
    return this.inbox.receiveQuotationFile(requestTx(), docId, verId, src, length);
  }

  /** VendorQuotationSubmissionBody → a `received` inbox row; 404 for an RFQ the caller is not invited to. */
  @Post('quotation-submissions')
  @Can('portal.vendor.submit')
  submitQuotation(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<InboxReceipt> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.inbox.submitQuotation(requestTx(), body, key);
  }
}
