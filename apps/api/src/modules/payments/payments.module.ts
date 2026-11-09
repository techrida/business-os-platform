// Payments module (P3 U7): customer receipts. Registers the `payment` and `payment_intake` document owner policies,
// provides PaymentsService (exported: the portal billing API of U13 calls `submit(..., 'portal', ...)` and
// `withdraw`) and serves /v1/payments. Imports DocumentsModule (owner registry), SettingsModule (MoneyService,
// NumberingService), AuditModule and LedgerModule; the database and AuthzModule are global.
import { Inject, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { DB, type Db } from '../../platform/db/db.module';
import { DocumentsModule } from '../../platform/documents/documents.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsModule } from '../../platform/settings/settings.module';
import { LedgerModule } from '../ledger/ledger.module';
import {
  drizzleCustomerPartyLoader,
  drizzlePaymentHeadLoader,
  PaymentIntakeOwnerPolicy,
  PaymentOwnerPolicy,
} from './payment-owner.policy';
import { PaymentsCaller } from './payments.caller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [AuditModule, DocumentsModule, LedgerModule, SettingsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsCaller],
  exports: [PaymentsService],
})
export class PaymentsModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  /** The registry throws on a duplicate owner type, so this runs once, when the module starts. */
  onModuleInit(): void {
    this.documents.registerOwner(new PaymentOwnerPolicy(drizzlePaymentHeadLoader(this.db)));
    this.documents.registerOwner(new PaymentIntakeOwnerPolicy(drizzleCustomerPartyLoader(this.db)));
  }
}
