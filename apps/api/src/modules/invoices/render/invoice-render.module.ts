// Invoice render module, API side (P3 unit U11): serves `GET /v1/invoices/:id/document`. It registers no owner policy:
// InvoicesModule registers InvoiceOwnerPolicy on the shared DocumentsService, and a second registration throws.
// Rendering itself runs in the worker (InvoiceRenderWorkerModule), never here.
import { Module } from '@nestjs/common';

import { DocumentsModule } from '../../../platform/documents/documents.module';
import { InvoiceCaller } from '../invoice-support';
import { InvoiceDocumentController } from './invoice-document.controller';
import { InvoiceDocumentService } from './invoice-document.service';

@Module({
  imports: [DocumentsModule],
  controllers: [InvoiceDocumentController],
  providers: [InvoiceCaller, InvoiceDocumentService],
})
export class InvoiceRenderModule {}
