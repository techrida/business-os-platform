// Payment requests module (P4 unit A2): the REST routes of payment requests and the registration of the
// payment_request approval subject. The service reads the vendor's verified bank account (VendorBankModule) and the
// open amounts and lock order of the payable items (LedgerModule) and the enabled currencies (SettingsModule); it
// writes no ledger rows. onDecided runs only
// from ApprovalsService.act (an API route), so the worker never needs the subject.
import { Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditService } from '../../../platform/audit/audit.service';
import { SettingsModule } from '../../../platform/settings/settings.module';
import { ApprovalsModule } from '../../approvals/approvals.module';
import { ApprovalsService } from '../../approvals/requests.service';
import { LedgerModule } from '../../ledger/ledger.module';
import { VendorBankModule } from '../../vendors/bank/bank.module';
import { PaymentRequestSubject } from './payment-request.subject';
import { PaymentRequestsCaller } from './payment-requests.caller';
import { PaymentRequestsController } from './payment-requests.controller';
import { PaymentRequestsService } from './payment-requests.service';

@Module({
  imports: [ApprovalsModule, AuditModule, LedgerModule, SettingsModule, VendorBankModule],
  controllers: [PaymentRequestsController],
  providers: [PaymentRequestsService, PaymentRequestsCaller],
  exports: [PaymentRequestsService],
})
export class PaymentRequestsModule implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.approvals.registerSubject(new PaymentRequestSubject(this.audit));
  }
}
