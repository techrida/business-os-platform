// The documents owner policy of a vendor bank account's call-back evidence (P4 V2, V2b; AD9). Owner type
// `vendor_bank_account`, owner id = the account id. Serves the NFRs:
// - "a payment goes only to a verified account": the evidence is attached by the maker (procurement, who proposes
//   the account) with `vendor.bank.propose` (`uploadPermission`), not the generic `documents.upload`, and read by
//   the checker (finance, `vendor.bank.verify`) with `documents.read`;
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

/** Procurement proposes the account and attaches the call-back proof with the same grant. */
export const BANK_EVIDENCE_UPLOAD_PERMISSION: Permission = 'vendor.bank.propose';

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
    uploadPermission: BANK_EVIDENCE_UPLOAD_PERMISSION,
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
