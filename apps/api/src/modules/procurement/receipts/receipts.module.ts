// Receipts module (P4 unit P4r): the REST routes of goods and service receipts, of a PO's progress and of the POs
// open for receiving (P2d-2), and the services behind them. Imports AuditModule, SettingsModule (NumberingService)
// and ApprovalsModule; the database and authz are global. A receipt is confirmed by a person, not decided by a
// workflow; the one approval subject here is the review of an emergency purchase after receipt (F1-Q41).
import { Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditService } from '../../../platform/audit/audit.service';
import { SettingsModule } from '../../../platform/settings/settings.module';
import { ApprovalsModule } from '../../approvals/approvals.module';
import { ApprovalsService } from '../../approvals/requests.service';
import { EmergencyReviewSubject } from './emergency-review';
import {
  PurchaseOrderProgressController,
  ReceivableOrdersController,
  ReceivedOrdersController,
  ReceiptsController,
  RequestedOrdersController,
} from './receipts.controller';
import { ReceivableOrdersService } from './receivable-orders.service';
import { ReceiptsCaller } from './receipts.caller';
import { ReceiptsService } from './receipts.service';
import { RequestedOrdersService } from './requested-orders.service';

@Module({
  imports: [AuditModule, SettingsModule, ApprovalsModule],
  controllers: [
    ReceiptsController,
    PurchaseOrderProgressController,
    ReceivableOrdersController,
    ReceivedOrdersController,
    RequestedOrdersController,
  ],
  providers: [ReceiptsService, ReceiptsCaller, ReceivableOrdersService, RequestedOrdersService],
  exports: [ReceiptsService],
})
export class ReceiptsModule implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.approvals.registerSubject(new EmergencyReviewSubject(this.audit, this.approvals));
  }
}
