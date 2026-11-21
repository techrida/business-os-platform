// Purchase order render module, API side (P4 unit P3b): serves
// `GET /v1/procurement/purchase-orders/:id/versions/:version/document`. Unlike InvoiceRenderModule it registers the
// owner policy itself, because the module that owns purchase orders does not: without the registration
// DocumentsService.issueLinkForOwner refuses every owner of this type with a 404. Rendering itself runs in the worker
// (PurchaseOrderRenderWorkerModule), never here.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../../platform/audit/audit.module';
import { DB, type Db } from '../../../../platform/db/db.module';
import { DocumentsModule } from '../../../../platform/documents/documents.module';
import { DocumentsService } from '../../../../platform/documents/documents.service';
import { PurchaseOrdersCaller } from '../purchase-orders.caller';
import { PurchaseOrderRenderNudgeModule } from './purchase-order-render.nudge';
import { PurchaseOrderDocumentController } from './purchase-order-document.controller';
import { PurchaseOrderDocumentService } from './purchase-order-document.service';
import {
  drizzlePoVersionHeadLoader,
  PurchaseOrderVersionOwnerPolicy,
} from './purchase-order-version-owner.policy';

@Module({
  imports: [AuditModule, DocumentsModule, PurchaseOrderRenderNudgeModule],
  controllers: [PurchaseOrderDocumentController],
  providers: [PurchaseOrdersCaller, PurchaseOrderDocumentService],
})
export class PurchaseOrderRenderModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /** registerOwner throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(
      new PurchaseOrderVersionOwnerPolicy(drizzlePoVersionHeadLoader(this.db)),
    );
  }
}
