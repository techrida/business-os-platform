// Vendor bill inbox module (P4 unit A1d): the staff routes over the portal's bill submissions. Converting runs in
// VendorBillsService (exported by VendorBillsModule), so the bill and the submission move in one transaction.
import { Module } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { BillSubmissionsController } from './bill-submissions.controller';
import { BillSubmissionsService } from './bill-submissions.service';
import { VendorBillsCaller } from './vendor-bills.caller';
import { VendorBillsModule } from './vendor-bills.module';

@Module({
  imports: [AuditModule, VendorBillsModule],
  controllers: [BillSubmissionsController],
  providers: [BillSubmissionsService, VendorBillsCaller],
})
export class BillSubmissionsModule {}
