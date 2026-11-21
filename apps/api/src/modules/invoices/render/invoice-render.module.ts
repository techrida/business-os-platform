// Invoice render module, API side (P3 unit U11): serves `GET /v1/invoices/:id/document` and, since round 4, the retry
// of a render that was given up (`POST /v1/invoices/:id/document/retry`). It registers no owner policy:
// InvoicesModule registers InvoiceOwnerPolicy on the shared DocumentsService, and a second registration throws.
// Rendering itself runs in the worker (InvoiceRenderWorkerModule), never here.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { DocumentsModule } from '../../../platform/documents/documents.module';
import { InvoiceCaller } from '../invoice-support';
import { InvoiceDocumentController } from './invoice-document.controller';
import { InvoiceDocumentService } from './invoice-document.service';
import { InvoiceRenderNudgeModule } from './invoice-render.nudge';

@Module({
  imports: [AuditModule, DocumentsModule, InvoiceRenderNudgeModule],
  controllers: [InvoiceDocumentController],
  providers: [InvoiceCaller, InvoiceDocumentService],
})
export class InvoiceRenderModule {}
