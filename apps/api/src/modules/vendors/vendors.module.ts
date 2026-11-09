// Vendors module (P4 unit V1): the tenant-level vendor records, their contacts and their per-entity accounts.
// It imports VerificationModule (for the vendor KYB case) and AuditModule (the lifecycle events). AuthzModule and
// the database are global. VendorPartyOwnerRegistrar registers the vendor adapter with VerificationService when
// the module starts. Only AppModule imports this module; the daily KYC expiry check is a method a worker job calls
// (VendorsService.suspendLapsedKyc), see the hand-back for the wiring.
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { VerificationModule } from '../verification/verification.module';
import { VerificationService } from '../verification/verification.service';
import { VendorPartyOwner } from './vendor-party-owner';
import { VendorsCaller } from './vendors.caller';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';

/** Gives VerificationService the vendor adapter; its registry throws on a second registration of the kind. */
@Injectable()
export class VendorPartyOwnerRegistrar implements OnModuleInit {
  constructor(private readonly verification: VerificationService) {}

  onModuleInit(): void {
    this.verification.registerPartyOwner(new VendorPartyOwner());
  }
}

@Module({
  imports: [VerificationModule, AuditModule],
  controllers: [VendorsController],
  providers: [VendorsService, VendorsCaller, VendorPartyOwnerRegistrar],
  exports: [VendorsService],
})
export class VendorsModule {}
