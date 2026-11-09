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

import { Can } from '../../../platform/authz/decorators';
import { parseContentLength } from '../../../platform/documents/documents.controller';
import { BillDocumentsService, type CreatedBillDocument } from './bill-documents.service';

@Controller('v1/payables/bill-documents')
export class BillDocumentsController {
  constructor(private readonly documents: BillDocumentsService) {}

  @Post()
  @Can('payables.bill.enter')
  create(@Body() body: unknown): Promise<CreatedBillDocument> {
    return this.documents.create(body);
  }

  /** Send raw bytes with the file's own Content-Type so body parsers leave the stream intact. */
  @Put(':docId/versions/:verId/content')
  @Can('payables.bill.enter')
  upload(
    @Param('docId') docId: string,
    @Param('verId') verId: string,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    const length = parseContentLength(req.headers['content-length']);
    if (req.readableEnded) {
      throw new UnsupportedMediaTypeException(
        'Send the file with its own Content-Type (for example application/pdf), not as JSON or a form',
      );
    }
    return this.documents.receive(docId, verId, req, length);
  }
}
