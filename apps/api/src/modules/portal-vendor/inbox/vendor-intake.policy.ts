// The documents owner policy of files a vendor uploads from the portal before the inbox row exists (P4 PV2): a
// quotation PDF now, an invoice later. Owner type `vendor_portal_intake`, owner id = the vendor party, the vendor twin
// of P3's `payment_intake`. Serves the NFRs:
// - "deny by default": only a vendor portal caller whose own party is the owner passes `allowsCounterparty`; staff
//   keep the usual `documents.upload` check on the vendor's ref, and no job adds files here;
// - "no unscanned file is ever served": the type, size and scan rules of DocumentsService are unchanged.
// VendorPortalInboxModule registers it when it starts.
import { scoped, vendorBills, vendorBillSubmissions, vendors } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import type { Db } from '../../../platform/db/db.module';
import type { DocumentOwnerPolicy } from '../../../platform/documents/documents.ports';

export const VENDOR_INTAKE_OWNER_TYPE = 'vendor_portal_intake';

export function vendorIntakeOwnerPolicy(db: Db): DocumentOwnerPolicy {
  return {
    ownerType: VENDOR_INTAKE_OWNER_TYPE,
    canAttach: async (scope, _vendorId, tx, documentId) => {
      if (documentId === undefined) return true;
      const submissionsQuery = (tx ?? db)
        .select({ status: vendorBillSubmissions.status })
        .from(vendorBillSubmissions)
        .where(
          scoped(scope).where(
            vendorBillSubmissions,
            eq(vendorBillSubmissions.documentId, documentId),
          ),
        );
      const submissions =
        tx === undefined ? await submissionsQuery : await submissionsQuery.for('share');
      if (submissions.some((submission) => submission.status === 'converted')) return false;
      const billsQuery = (tx ?? db)
        .select({ status: vendorBills.status })
        .from(vendorBills)
        .where(scoped(scope).where(vendorBills, eq(vendorBills.documentId, documentId)));
      const bills = tx === undefined ? await billsQuery : await billsQuery.for('share');
      return bills.every((bill) => bill.status === 'draft' || bill.status === 'discarded');
    },
    // A vendor is tenant-level, so the ref is the vendor's in the acting entity, like the vendor's own records.
    resource: async (scope, vendorPartyId) => {
      const [row] = await db
        .select({ id: vendors.id, ownerUserId: vendors.ownerUserId })
        .from(vendors)
        .where(and(eq(vendors.tenantId, scope.tenantId), eq(vendors.id, vendorPartyId)));
      if (row === undefined) return null;
      return {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        ownerUserId: row.ownerUserId,
        vendorPartyId: row.id,
      };
    },
    allowsCounterparty: async (who, vendorPartyId, tx) => {
      if (who.kind !== 'vendor' || who.partyId !== vendorPartyId) return false;
      const [row] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(and(eq(vendors.tenantId, who.tenantId), eq(vendors.id, vendorPartyId)));
      return row !== undefined;
    },
  };
}
