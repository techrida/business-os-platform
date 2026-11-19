// The vendor adapter of PartyOwnerPort: a vendor is the `vendors` row of a vendor party. VendorsModule registers it
// with VerificationService when the module starts, so the KYB case of a vendor opens through the same routes as a
// customer's. It writes with `vendor.write` and names the vendor in the authz `vendorPartyId` field.
import { vendors } from '@bos/db';
import { and, eq, inArray, notInArray } from 'drizzle-orm';

import {
  type PartyOwner,
  type PartyOwnerPort,
  type PartyQuery,
} from '../verification/party-owner.port';

export class VendorPartyOwner implements PartyOwnerPort {
  readonly kind = 'vendor' as const;
  readonly label = 'Vendor';
  readonly writePermission = 'vendor.write' as const;

  /** A blocked or archived vendor gets no new case; its old case stays readable (`ownersOf`). */
  async findLive(
    q: PartyQuery,
    tenantId: string,
    partyId: string,
  ): Promise<PartyOwner | undefined> {
    const [vendor] = await q
      .select({ id: vendors.id, ownerUserId: vendors.ownerUserId })
      .from(vendors)
      .where(
        and(
          eq(vendors.tenantId, tenantId),
          eq(vendors.id, partyId),
          notInArray(vendors.status, ['blocked', 'archived']),
        ),
      );
    return vendor;
  }

  async ownersOf(
    q: PartyQuery,
    tenantId: string,
    partyIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> {
    if (partyIds.length === 0) return new Map();
    const rows = await q
      .select({ id: vendors.id, ownerUserId: vendors.ownerUserId })
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), inArray(vendors.id, [...partyIds])));
    return new Map(rows.map((r) => [r.id, r.ownerUserId]));
  }

  /** Every vendor the user owns, blocked or archived ones included: their old cases stay readable. */
  ownedBy(q: PartyQuery, tenantId: string, userId: string) {
    return q
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.ownerUserId, userId)));
  }

  counterparty(partyId: string) {
    return { vendorPartyId: partyId };
  }
}
