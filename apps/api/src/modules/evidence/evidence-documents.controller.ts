// HTTP routes of evidence uploads (round 5 P2). Three routes per record kind, each with that kind's own permission:
// create the document (JSON body: filename, declaredMime, sizeBytes), PUT its raw bytes to the `uploadPath` the
// create returned (send the file with its own Content-Type and an exact Content-Length, as for every upload), and
// GET the file with its versions (the dialog's scan-status poll), and DELETE a file its uploader abandoned before
// saving (204, also when it is already removed).
import type { DocumentVersionDto } from '@bos/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';

import { Can } from '../../platform/authz/decorators';
import { parseContentLength } from '../../platform/documents/documents.controller';
import type { DocumentDto } from '../../platform/documents/documents.service';
import type { EvidenceRecordKind } from './evidence-owner.policy';
import {
  EvidenceDocumentsService,
  type CreatedEvidenceDocument,
} from './evidence-documents.service';

/** The raw body is the file: 411/400 for a bad Content-Length, 415 when a body parser already read it. */
function rawLength(req: Request): number {
  const length = parseContentLength(req.headers['content-length']);
  if (req.readableEnded) {
    throw new UnsupportedMediaTypeException(
      'Send the file with its own Content-Type (for example application/pdf), not as JSON or a form',
    );
  }
  return length;
}

@Controller('v1')
export class EvidenceDocumentsController {
  constructor(private readonly evidence: EvidenceDocumentsService) {}

  private receive(
    kind: EvidenceRecordKind,
    id: string,
    docId: string,
    verId: string,
    req: Request,
  ): Promise<DocumentVersionDto> {
    const length = rawLength(req);
    return this.evidence.receive(kind, id, docId, verId, req, length);
  }

  @Post('sales-orders/:id/evidence-documents')
  @Can('sales_order.mark_billable')
  createForSalesOrder(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CreatedEvidenceDocument> {
    return this.evidence.create('sales_order', id, body);
  }

  @Put('sales-orders/:id/evidence-documents/:docId/versions/:verId/content')
  @Can('sales_order.mark_billable')
  uploadForSalesOrder(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Param('verId') verId: string,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    return this.receive('sales_order', id, docId, verId, req);
  }

  @Get('sales-orders/:id/evidence-documents/:docId')
  @Can('sales_order.mark_billable')
  readForSalesOrder(@Param('id') id: string, @Param('docId') docId: string): Promise<DocumentDto> {
    return this.evidence.read('sales_order', id, docId);
  }

  @Delete('sales-orders/:id/evidence-documents/:docId')
  @Can('sales_order.mark_billable')
  @HttpCode(204)
  removeForSalesOrder(@Param('id') id: string, @Param('docId') docId: string): Promise<void> {
    return this.evidence.remove('sales_order', id, docId);
  }

  @Post('payables/bills/:id/evidence-documents')
  @Can('payables.bill.enter')
  createForBill(@Param('id') id: string, @Body() body: unknown): Promise<CreatedEvidenceDocument> {
    return this.evidence.create('vendor_bill', id, body);
  }

  @Put('payables/bills/:id/evidence-documents/:docId/versions/:verId/content')
  @Can('payables.bill.enter')
  uploadForBill(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Param('verId') verId: string,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    return this.receive('vendor_bill', id, docId, verId, req);
  }

  @Get('payables/bills/:id/evidence-documents/:docId')
  @Can('payables.bill.enter')
  readForBill(@Param('id') id: string, @Param('docId') docId: string): Promise<DocumentDto> {
    return this.evidence.read('vendor_bill', id, docId);
  }

  @Delete('payables/bills/:id/evidence-documents/:docId')
  @Can('payables.bill.enter')
  @HttpCode(204)
  removeForBill(@Param('id') id: string, @Param('docId') docId: string): Promise<void> {
    return this.evidence.remove('vendor_bill', id, docId);
  }

  @Post('procurement/rfqs/:id/evidence-documents')
  @Can('procurement.sourcing')
  createForRfq(@Param('id') id: string, @Body() body: unknown): Promise<CreatedEvidenceDocument> {
    return this.evidence.create('rfq', id, body);
  }

  @Put('procurement/rfqs/:id/evidence-documents/:docId/versions/:verId/content')
  @Can('procurement.sourcing')
  uploadForRfq(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Param('verId') verId: string,
    @Req() req: Request,
  ): Promise<DocumentVersionDto> {
    return this.receive('rfq', id, docId, verId, req);
  }

  @Get('procurement/rfqs/:id/evidence-documents/:docId')
  @Can('procurement.sourcing')
  readForRfq(@Param('id') id: string, @Param('docId') docId: string): Promise<DocumentDto> {
    return this.evidence.read('rfq', id, docId);
  }

  @Delete('procurement/rfqs/:id/evidence-documents/:docId')
  @Can('procurement.sourcing')
  @HttpCode(204)
  removeForRfq(@Param('id') id: string, @Param('docId') docId: string): Promise<void> {
    return this.evidence.remove('rfq', id, docId);
  }
}
