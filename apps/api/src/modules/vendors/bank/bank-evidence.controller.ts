// Staff routes for a bank account's call-back evidence (P4 V2b, AD9): whoever proposes accounts
// (`vendor.bank.propose`, procurement) or verifies them (`vendor.bank.verify`, finance) uploads the proof of the
// call-back. `@Can` names one permission, so the routes are `@AnyAuthenticated` and the service refuses (403) a
// caller holding neither grant before it reads anything; DocumentsService then checks either grant on the vendor's
// ref. Two steps, like
// /v1/payment-proofs: POST declares the file and returns `uploadPath`, then a raw PUT of the bytes to that path,
// sent with the file's own Content-Type so the global body parsers leave the request stream untouched. No
// Idempotency-Key: like every documents create, a retried POST leaves an empty draft document, nothing more.
import type { DocumentVersionDto } from '@bos/contracts';
import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';

import { AnyAuthenticated } from '../../../platform/authz/decorators';
import { parseContentLength } from '../../../platform/documents/documents.controller';
import { VendorBankEvidenceService, type CreatedBankEvidence } from './bank-evidence.service';

@Controller('v1/vendors/:id/bank-accounts/:accountId/evidence')
export class VendorBankEvidenceController {
  constructor(private readonly evidence: VendorBankEvidenceService) {}

  /**
   * `{filename, declaredMime, sizeBytes}` → 201 `{documentId, versionId, uploadPath}`. 404 for an account that is
   * not the vendor's in this tenant, 409 once the account is no longer proposed.
   */
  @Post()
  @AnyAuthenticated()
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() body: unknown,
  ): Promise<CreatedBankEvidence> {
    return this.evidence.create(id, accountId, body);
  }

  /** The raw file bytes for a version from `create`. Any id that is not evidence of this account is the same 404. */
  @Put(':docId/versions/:verId/content')
  @AnyAuthenticated()
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('docId') docId: string,
    @Param('verId') verId: string,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    this.evidence.assertMayAttach();
    const length = parseContentLength(req.headers['content-length']);
    if (req.readableEnded) {
      // A body parser already consumed the stream: the client sent the file as application/json or a form.
      throw new UnsupportedMediaTypeException(
        'Send the file with its own Content-Type (for example application/pdf), not as JSON or a form',
      );
    }
    return this.evidence.receive(id, accountId, docId, verId, req, length);
  }
}
