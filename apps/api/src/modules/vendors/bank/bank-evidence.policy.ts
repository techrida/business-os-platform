// The documents owner policy of a vendor bank account's call-back evidence (P4 V2, V2b; AD9). Owner type
// `vendor_bank_account`, owner id = the account id. Serves the NFRs:
// - "a payment goes only to a verified account": the evidence is attached with `vendor.bank.propose` (procurement,
//   who proposes accounts) or `vendor.bank.verify` (finance, who makes the call-back, also for an account the vendor
//   proposed from the portal) (`uploadPermission`, any one of them), not the generic `documents.upload`. It is
//   read with `vendor.read` on the vendor, the grant that shows the bank accounts themselves (`readPermission`), or
//   `documents.read`, so procurement can open evidence on a vendor it does not own without a wider
//   `documents.read`. The maker-checker rule (the proposer never verifies) stays in BankService;
// - "deny by default": evidence is attached only while the account is proposed (once decided it is part of what
//   was approved), no job adds files and no portal caller uploads here.
// VendorBankModule registers it through BankEvidenceOwnerRegistrar.
import type { Permission } from '@bos/contracts';
import { vendorBankAccounts, vendors } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import type { DocumentOwnerPolicy } from '../../../platform/documents/documents.ports';
import { BANK_EVIDENCE_OWNER_TYPE } from './bank.rules';

/**
 * Who may attach the call-back proof: whoever proposes accounts or whoever verifies them. Verify needs evidence, so
 * without the second finance could not verify an account the vendor proposed from the portal.
 */
export const BANK_EVIDENCE_UPLOAD_PERMISSIONS: readonly Permission[] = [
  'vendor.bank.propose',
  'vendor.bank.verify',
];

/**
 * The resource is the vendor's ref in the acting entity (a vendor is tenant-level), the same ref vendorRef() gives
 * the bank routes, so the upload grant and `documents.read` are decided like the vendor's own records.
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
    uploadPermission: BANK_EVIDENCE_UPLOAD_PERMISSIONS,
    readPermission: 'vendor.read',
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
