// Vendor portal inbox writes module (P4 units PV2, PV2b): KYC documents, quotation and bill submissions and bank
// change requests under /v1/portal/vendor. Imports DocumentsModule (uploads, scan), AuditModule and VendorBankModule
// (VendorBankService.proposeFromPortal) and SettingsModule (CurrencyEnabledService: a quotation or bill must be in a
// currency the company switched on, D44); the database and AuthzModule are global. It registers the
// `vendor_portal_intake` owner policy when it starts. KYC files use the `verification_case` owner type, whose policy
// (with its vendor `allowsCounterparty`) VerificationModule registers, so AppModule must import VerificationModule too.
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { DB, type Db } from '../../../platform/db/db.module';
import { DocumentsModule } from '../../../platform/documents/documents.module';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { SettingsModule } from '../../../platform/settings/settings.module';
import { VendorPortalCaller } from '../../portal/vendor-portal.caller';
import { VendorBankModule } from '../../vendors/bank/bank.module';
import { VendorPortalInboxController } from './portal-vendor-inbox.controller';
import { VendorPortalInboxService } from './portal-vendor-inbox.service';
import { vendorIntakeOwnerPolicy } from './vendor-intake.policy';

@Injectable()
export class VendorIntakeOwnerRegistrar implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.documents.registerOwner(vendorIntakeOwnerPolicy(this.db));
  }
}

@Module({
  imports: [DocumentsModule, AuditModule, VendorBankModule, SettingsModule],
  controllers: [VendorPortalInboxController],
  providers: [VendorPortalInboxService, VendorPortalCaller, VendorIntakeOwnerRegistrar],
})
export class VendorPortalInboxModule {}
