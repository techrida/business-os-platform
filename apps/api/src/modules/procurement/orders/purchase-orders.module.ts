// Purchase orders module (P4 unit P3): the REST routes of purchase orders (list, detail, versions, issue, amend,
// short-close, cancel) and the registration of the po_amendment approval subject. onDecided runs only from
// ApprovalsService.act (an API route), so the worker never needs the subject. Round 5 (S3): a command that creates
// a version (issue, an amendment applied at once or approved) enqueues its PDF render through
// PurchaseOrderRenderNudgeModule once it commits; the render worker's sweep stays the safety net.
import { Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditService } from '../../../platform/audit/audit.service';
import { ApprovalsModule } from '../../approvals/approvals.module';
import { ApprovalsService } from '../../approvals/requests.service';
import { PoAmendmentSubject } from './po-amendment.subject';
import { PoVendorChangeSubject } from './po-vendor-change.subject';
import { PurchaseOrdersCaller } from './purchase-orders.caller';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  PurchaseOrderRenderNudge,
  PurchaseOrderRenderNudgeModule,
} from './render/purchase-order-render.nudge';

@Module({
  imports: [ApprovalsModule, AuditModule, PurchaseOrderRenderNudgeModule],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService, PurchaseOrdersCaller],
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly renderNudge: PurchaseOrderRenderNudge,
  ) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.approvals.registerSubject(
      new PoAmendmentSubject(this.audit, this.approvals, undefined, this.renderNudge),
    );
    this.approvals.registerSubject(new PoVendorChangeSubject(this.audit, this.approvals));
  }
}
