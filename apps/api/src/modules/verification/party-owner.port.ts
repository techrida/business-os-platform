// PartyOwnerPort: how the verification case reaches the party it verifies, one adapter per party kind. The KYB
// case is shared by customers and vendors (the `party_kind` of the case), but each kind keeps its own record
// (customers today, vendors in P4 V1): who owns it, which authz field names it, and which permission writes it.
// The service asks the registry for the adapter of the case's kind, so it never joins a kind's table itself.
// V1 registers the vendor adapter through `VerificationService.registerPartyOwner` (see the registration point
// there); until then a vendor party has no adapter and is "not found", which is the deny-by-default answer.
import { type Permission, type VerificationPartyKind } from '@bos/contracts';
import { type SQLWrapper } from 'drizzle-orm';

import { type ResourceRef } from '../../platform/authz/can';
import { type Db, type DbTransaction } from '../../platform/db/db.module';

/** A query handle: the pool, or the caller's transaction so a locked read sees the same snapshot. */
export type PartyQuery = Db | DbTransaction;

/** A live party of one kind, as the create needs it. */
export interface PartyOwner {
  id: string;
  ownerUserId: string | null;
}

/** How a case names its party: the legal name and, for a kind that numbers its parties, the number. */
export interface PartyLabel {
  name: string;
  number: string | null;
}

export interface PartyOwnerPort {
  readonly kind: VerificationPartyKind;
  /** What the party is called in a "not found" message, for example `Customer`. */
  readonly label: string;
  /** The permission that opens a case, edits its checklist and submits it for a party of this kind. */
  readonly writePermission: Permission;
  /** The live (for a customer: not merged away) party of this tenant, or undefined. Used to open a case. */
  findLive(q: PartyQuery, tenantId: string, partyId: string): Promise<PartyOwner | undefined>;
  /**
   * The owner user of each given party that exists in this tenant (null for no owner). A party that is not in
   * the map does not exist here; the case of such a party reads as not found. One query for any number of ids.
   */
  ownersOf(
    q: PartyQuery,
    tenantId: string,
    partyIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
  /**
   * The ids of this tenant's parties of this kind that `userId` owns, as a subquery: what the `own` scope of
   * verification.read reaches, so a case list is scoped in SQL before its limit, never filtered after it.
   */
  ownedBy(q: PartyQuery, tenantId: string, userId: string): SQLWrapper;
  /**
   * The display name and number of each given party of this tenant (number null for a kind without one). One
   * query for any number of ids. Only these two fields: a case reader learns the party's label, nothing else.
   */
  labelsOf(
    q: PartyQuery,
    tenantId: string,
    partyIds: readonly string[],
  ): Promise<ReadonlyMap<string, PartyLabel>>;
  /** The counterparty field of the authz `ResourceRef` that names this party. */
  counterparty(partyId: string): Pick<ResourceRef, 'customerPartyId' | 'vendorPartyId'>;
}

/** The adapters by kind. Unregistered kinds have none: `find` returns undefined. */
export class PartyOwnerRegistry {
  private readonly ports = new Map<VerificationPartyKind, PartyOwnerPort>();

  constructor(ports: readonly PartyOwnerPort[] = []) {
    for (const port of ports) this.register(port);
  }

  /** One adapter per kind: a second registration is a wiring bug, so it throws. */
  register(port: PartyOwnerPort): void {
    if (this.ports.has(port.kind)) {
      throw new Error(`a party owner port for kind ${port.kind} is already registered`);
    }
    this.ports.set(port.kind, port);
  }

  find(kind: VerificationPartyKind): PartyOwnerPort | undefined {
    return this.ports.get(kind);
  }

  /** Every registered adapter. */
  all(): PartyOwnerPort[] {
    return [...this.ports.values()];
  }
}
