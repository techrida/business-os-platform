// Customer portal routes for payment-proof uploads (P3 U13 part 2). The portal UI (p3/u16) calls these paths.
// The upload is two steps, like /v1/documents: POST declares the file and returns `uploadPath`, then a raw PUT of the
// bytes to that path. The global JSON and urlencoded parsers only act on those two content types, so the file is
// sent with its own type (for example application/pdf) and the handler gets the untouched request stream.
import type { DocumentVersionDto } from '@bos/contracts';
import {
  Body,
  Controller,
  Param,
  Post,
  Put,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';

import { Can } from '../../platform/authz/decorators';
import { principal } from '../../platform/authz/principal';
import { requestTx } from '../../platform/db/tx';
import { parseContentLength } from '../../platform/documents/documents.controller';
import { PaymentProofsService, type CreatedPaymentProof } from './payment-proofs.service';

@Controller('v1/portal/payment-proofs')
export class PortalPaymentProofsController {
  constructor(private readonly proofs: PaymentProofsService) {}

  /** `{filename, declaredMime, sizeBytes}` → `{documentId, versionId, uploadPath}`, owned by the caller's party. */
  @Post()
  @Can('portal.payment.submit')
  create(@Body() body: unknown): Promise<CreatedPaymentProof> {
    return this.proofs.createForPortal(principal(), requestTx(), body);
  }

  /** The raw file bytes for a version from `create`. Any id the caller may not see is the same 404. */
  @Put(':docId/versions/:verId/content')
  @Can('portal.payment.submit')
  upload(
    @Param('docId') docId: string,
    @Param('verId') verId: string,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    const length = parseContentLength(req.headers['content-length']);
    if (req.readableEnded) {
      // A body parser already consumed the stream: the client sent the file as application/json or a form.
      throw new UnsupportedMediaTypeException(
        'Send the file with its own Content-Type (for example application/pdf), not as JSON or a form',
      );
    }
    return this.proofs.receiveForPortal(principal(), requestTx(), docId, verId, req, length);
  }
}
