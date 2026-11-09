// Vendor bank accounts module (P4 unit V2, AD9). It imports CryptoModule (FieldCipher, needs FIELD_ENC_KEYS),
// DocumentsModule (the call-back evidence is a document of owner type `vendor_bank_account`) and AuditModule.
// AuthzModule and the database are global. BankEvidenceOwnerRegistrar registers the evidence owner policy with
// DocumentsService when the module starts (bank-evidence.policy.ts); VendorBankEvidenceController is its staff
// upload route (V2b). Only AppModule imports this module; A2 and PV2 import it for
// VendorBankService (activeVerifiedAccount, proposeFromPortal).
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { CryptoModule } from '../../../platform/crypto/crypto.module';
import { DB, type Db } from '../../../platform/db/db.module';
import { DocumentsModule } from '../../../platform/documents/documents.module';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { VendorsCaller } from '../vendors.caller';
import { VendorBankEvidenceController } from './bank-evidence.controller';
import { bankEvidenceOwnerPolicy } from './bank-evidence.policy';
import { VendorBankEvidenceService } from './bank-evidence.service';
import { VendorBankController } from './bank.controller';
import { VendorBankService } from './bank.service';

@Injectable()
export class BankEvidenceOwnerRegistrar implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.documents.registerOwner(bankEvidenceOwnerPolicy(this.db));
  }
}

@Module({
  imports: [CryptoModule, DocumentsModule, AuditModule],
  controllers: [VendorBankController, VendorBankEvidenceController],
  providers: [
    VendorBankService,
    VendorBankEvidenceService,
    VendorsCaller,
    BankEvidenceOwnerRegistrar,
  ],
  exports: [VendorBankService],
})
export class VendorBankModule {}
