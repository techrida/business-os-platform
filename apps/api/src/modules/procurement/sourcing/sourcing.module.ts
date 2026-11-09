// Sourcing module (P4 unit P2): RFQ, quotation, comparison, recommendation and commitment routes, and the
// registration of the pr_commitment approval subject. onDecided runs only from ApprovalsService.act (an API route),
// so the worker never needs the subject.
import { Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsModule } from '../../../platform/settings/settings.module';
import { ApprovalsModule } from '../../approvals/approvals.module';
import { ApprovalsService } from '../../approvals/requests.service';
import { PurchaseRequestsCaller } from '../requests/purchase-requests.caller';
import { PrCommitmentSubject } from './pr-commitment.subject';
import { SourcingController } from './sourcing.controller';
import { SourcingService } from './sourcing.service';

@Module({
  imports: [ApprovalsModule, AuditModule, SettingsModule],
  controllers: [SourcingController],
  providers: [SourcingService, PurchaseRequestsCaller],
  exports: [SourcingService],
})
export class SourcingModule implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly numbering: NumberingService,
  ) {}

  /** The registry throws on a duplicate, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.approvals.registerSubject(new PrCommitmentSubject(this.numbering));
  }
}
