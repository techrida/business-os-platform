// Vendor bills module (P4 units A1 and A1b): the REST routes of bills (enter, match, exceptions, submit) and the
// registration of the vendor_bill and match_exception approval subjects. The vendor_bill subject posts an approved
// bill through LedgerService (the payable open item and vendor_bill_posted), so LedgerModule is imported. onDecided
// runs only from ApprovalsService.act (an API route), so the worker never needs the subjects.
import { Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditService } from '../../../platform/audit/audit.service';
import { SettingsModule } from '../../../platform/settings/settings.module';
import { ApprovalsModule } from '../../approvals/approvals.module';
import { ApprovalsService } from '../../approvals/requests.service';
import { LedgerModule } from '../../ledger/ledger.module';
import { LedgerService } from '../../ledger/ledger.service';
import { MatchExceptionSubject, VendorBillSubject } from './vendor-bill.subject';
import { VendorBillsCaller } from './vendor-bills.caller';
import { VendorBillsController } from './vendor-bills.controller';
import { VendorBillsService } from './vendor-bills.service';

@Module({
  imports: [ApprovalsModule, AuditModule, LedgerModule, SettingsModule],
  controllers: [VendorBillsController],
  providers: [VendorBillsService, VendorBillsCaller],
  exports: [VendorBillsService],
})
export class VendorBillsModule implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.approvals.registerSubject(
      new VendorBillSubject(this.audit, () => new Date(), this.ledger),
    );
    this.approvals.registerSubject(new MatchExceptionSubject(this.audit));
  }
}
