// The customer adapter of PartyOwnerPort: customers are the `customers` table (the CRM record of a customer party).
import { customers } from '@bos/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  type PartyLabel,
  type PartyOwner,
  type PartyOwnerPort,
  type PartyQuery,
} from './party-owner.port';

export class CustomerPartyOwner implements PartyOwnerPort {
  readonly kind = 'customer' as const;
  readonly label = 'Customer';
  readonly writePermission = 'customer.write' as const;

  async findLive(
    q: PartyQuery,
    tenantId: string,
    partyId: string,
  ): Promise<PartyOwner | undefined> {
    const [customer] = await q
      .select({ id: customers.id, ownerUserId: customers.ownerUserId })
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          eq(customers.id, partyId),
          isNull(customers.mergedIntoId),
        ),
      );
    return customer;
  }

  async ownersOf(
    q: PartyQuery,
    tenantId: string,
    partyIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> {
    if (partyIds.length === 0) return new Map();
    // A merged-away customer still has its cases: reading never filtered on mergedIntoId.
    const rows = await q
      .select({ id: customers.id, ownerUserId: customers.ownerUserId })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), inArray(customers.id, [...partyIds])));
    return new Map(rows.map((r) => [r.id, r.ownerUserId]));
  }

  async labelsOf(
    q: PartyQuery,
    tenantId: string,
    partyIds: readonly string[],
  ): Promise<ReadonlyMap<string, PartyLabel>> {
    if (partyIds.length === 0) return new Map();
    const rows = await q
      .select({ id: customers.id, name: customers.legalName, number: customers.number })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), inArray(customers.id, [...partyIds])));
    return new Map(rows.map((r) => [r.id, { name: r.name, number: r.number }]));
  }

  ownedBy(q: PartyQuery, tenantId: string, userId: string) {
    // A merged-away customer keeps its case, and its owner still reads it (ownersOf does not filter either).
    return q
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.ownerUserId, userId)));
  }

  counterparty(partyId: string) {
    return { customerPartyId: partyId };
  }
}
