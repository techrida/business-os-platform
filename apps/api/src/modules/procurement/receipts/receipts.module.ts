// Receipts module (P4 unit P4r): the REST routes of goods and service receipts, of a PO's progress and of the POs
// open for receiving (P2d-2), and the services behind them. Imports AuditModule and SettingsModule
// (NumberingService); the database and authz are global. No approval subject: a receipt is confirmed by a person,
// not decided by a workflow.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { SettingsModule } from '../../../platform/settings/settings.module';
import {
  PurchaseOrderProgressController,
  ReceivableOrdersController,
  ReceiptsController,
} from './receipts.controller';
import { ReceivableOrdersService } from './receivable-orders.service';
import { ReceiptsCaller } from './receipts.caller';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [ReceiptsController, PurchaseOrderProgressController, ReceivableOrdersController],
  providers: [ReceiptsService, ReceiptsCaller, ReceivableOrdersService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
