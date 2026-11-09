// Staff routes for payment-proof uploads (P3 U13 part 2): whoever records payments (`payment.record`) uploads the
// bank slip for a customer before submitting the payment. Two steps, like /v1/portal/payment-proofs: POST declares
// the file and the customer and returns `uploadPath`, then a raw PUT of the bytes to that path, sent with the file's
// own Content-Type so the global body parsers leave the request stream untouched.
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

@Controller('v1/payment-proofs')
export class StaffPaymentProofsController {
  constructor(private readonly proofs: PaymentProofsService) {}

  /** `{customerId, filename, declaredMime, sizeBytes}` → `{documentId, versionId, uploadPath}`. */
  @Post()
  @Can('payment.record')
  create(@Body() body: unknown): Promise<CreatedPaymentProof> {
    return this.proofs.createForStaff(principal(), requestTx(), body);
  }

  /** The raw file bytes for a version from `create`. Any id that is not a proof of this entity is the same 404. */
  @Put(':docId/versions/:verId/content')
  @Can('payment.record')
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
    return this.proofs.receiveForStaff(principal(), requestTx(), docId, verId, req, length);
  }
}
