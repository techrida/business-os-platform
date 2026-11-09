// Vendor bank accounts module (P4 unit V2, AD9). It imports CryptoModule (FieldCipher, needs FIELD_ENC_KEYS),
// DocumentsModule (the call-back evidence is a document of owner type `vendor_bank_account`) and AuditModule.
// AuthzModule and the database are global. BankEvidenceOwnerRegistrar registers the evidence owner policy with
// DocumentsService when the module starts. Only AppModule imports this module; A2 and PV2 import it for
// VendorBankService (activeVerifiedAccount, proposeFromPortal).
import { vendorBankAccounts, vendors } from '@bos/db';
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AuditModule } from '../../../platform/audit/audit.module';
import { CryptoModule } from '../../../platform/crypto/crypto.module';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { type TxScope } from '../../../platform/db/tx';
import { DocumentsModule } from '../../../platform/documents/documents.module';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { type DocumentOwnerPolicy } from '../../../platform/documents/documents.ports';
import { VendorsCaller } from '../vendors.caller';
import { BANK_EVIDENCE_OWNER_TYPE } from './bank.rules';
import { VendorBankController } from './bank.controller';
import { VendorBankService } from './bank.service';

/**
 * The owner policy of the call-back evidence. The resource is the vendor's ref in the acting entity (a vendor is
 * tenant-level), so `documents.upload`/`documents.read` are decided like the vendor's own records. Evidence can be
 * attached only while the account is proposed: once decided, the evidence is part of what was approved.
 */
export function bankEvidenceOwnerPolicy(db: Db): DocumentOwnerPolicy {
  const load = async (scope: TxScope, accountId: string, tx?: DbTransaction) => {
    const query = (tx ?? db)
      .select({
        status: vendorBankAccounts.status,
        vendorId: vendors.id,
        ownerUserId: vendors.ownerUserId,
      })
      .from(vendorBankAccounts)
      .innerJoin(
        vendors,
        and(
          eq(vendors.tenantId, vendorBankAccounts.tenantId),
          eq(vendors.id, vendorBankAccounts.vendorId),
        ),
      )
      .where(
        and(eq(vendorBankAccounts.tenantId, scope.tenantId), eq(vendorBankAccounts.id, accountId)),
      );
    const [row] = tx === undefined ? await query : await query.for('share');
    return row;
  };
  return {
    ownerType: BANK_EVIDENCE_OWNER_TYPE,
    resource: async (scope, accountId) => {
      const row = await load(scope, accountId);
      if (row === undefined) return null;
      return {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        ownerUserId: row.ownerUserId,
        vendorPartyId: row.vendorId,
      };
    },
    canAttach: async (scope, accountId, tx) =>
      (await load(scope, accountId, tx))?.status === 'proposed',
  };
}

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
  controllers: [VendorBankController],
  providers: [VendorBankService, VendorsCaller, BankEvidenceOwnerRegistrar],
  exports: [VendorBankService],
})
export class VendorBankModule {}
