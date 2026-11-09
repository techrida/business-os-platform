// The vendor portal's RFQ reads on the real tables (P4 unit PV3). An RFQ has no vendor column: the vendor is named
// by its invitation (`rfq_vendors`, one row per invited vendor). So the read starts at the invitation, limited by
// `scopeWhereFor(p, table, 'portal.vendor.read')`, the SQL twin of `can()`: for a vendor user at `customer_org` that
// is the tenant, the acting entity and the vendor column = `p.partyId` (ADR 0027 section 5); for anyone else it
// matches nothing. `rfq_vendors` is handed to the scope helper through a small counterparty view that names
// `vendor_id` as its `vendorPartyId` (vendors.id is the vendor's party id), the way portal-vendor.store.ts does for
// orders and bills. No hand-written party filter.
// Only an `open` RFQ is read: a closed, recommended or cancelled one is out of reach, the same as an uninvited one.
// The lines to quote are the RFQ's own purchase request lines, selected by name (description, unit, quantity): the
// estimated price and the specification stay in the database.
import { purchaseRequestLines, rfqs, rfqVendors } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import type { Principal, ScopableTable } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import type { RfqLineSource, RfqSource } from './portal-vendor-rfq.views';

const ACTION = 'portal.vendor.read' as const;

/** `rfq_vendors` as the scope helper reads it, with `vendor_id` named as the vendor counterparty column. */
const INVITATIONS = {
  tenantId: rfqVendors.tenantId,
  organizationId: rfqVendors.organizationId,
  vendorPartyId: rfqVendors.vendorId,
} as unknown as ScopableTable;

export interface VendorPortalRfqStore {
  /** Every open RFQ `p`'s vendor is invited to in the acting entity, soonest deadline first. */
  listOpenRfqs(p: Principal): Promise<RfqSource[]>;
  /** One open RFQ `p`'s vendor is invited to, with its lines; undefined for any other id. */
  loadOpenRfq(
    p: Principal,
    id: string,
  ): Promise<{ rfq: RfqSource; lines: RfqLineSource[] } | undefined>;
}

export const VENDOR_PORTAL_RFQ_STORE = Symbol('VENDOR_PORTAL_RFQ_STORE');

/** The invitation's own RFQ: same tenant, entity and id. */
const invitedRfq = and(
  eq(rfqs.tenantId, rfqVendors.tenantId),
  eq(rfqs.organizationId, rfqVendors.organizationId),
  eq(rfqs.id, rfqVendors.rfqId),
);

const rfqColumns = { id: rfqs.id, number: rfqs.number, deadline: rfqs.deadline };

@Injectable()
export class DrizzleVendorPortalRfqStore implements VendorPortalRfqStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listOpenRfqs(p: Principal): Promise<RfqSource[]> {
    return this.db
      .select(rfqColumns)
      .from(rfqVendors)
      .innerJoin(rfqs, invitedRfq)
      .where(and(scopeWhereFor(p, INVITATIONS, ACTION), eq(rfqs.status, 'open')))
      .orderBy(asc(rfqs.deadline), asc(rfqs.number));
  }

  async loadOpenRfq(
    p: Principal,
    id: string,
  ): Promise<{ rfq: RfqSource; lines: RfqLineSource[] } | undefined> {
    const [row] = await this.db
      .select({
        ...rfqColumns,
        tenantId: rfqs.tenantId,
        organizationId: rfqs.organizationId,
        purchaseRequestId: rfqs.purchaseRequestId,
      })
      .from(rfqVendors)
      .innerJoin(rfqs, invitedRfq)
      .where(and(scopeWhereFor(p, INVITATIONS, ACTION), eq(rfqs.status, 'open'), eq(rfqs.id, id)))
      .limit(1);
    if (row === undefined) return undefined;
    // The lines are read in the RFQ's own tenant and entity, taken from its row.
    const lines = await this.db
      .select({
        lineNo: purchaseRequestLines.lineNo,
        description: purchaseRequestLines.description,
        uom: purchaseRequestLines.uom,
        quantity: purchaseRequestLines.quantity,
      })
      .from(purchaseRequestLines)
      .where(
        and(
          eq(purchaseRequestLines.tenantId, row.tenantId),
          eq(purchaseRequestLines.organizationId, row.organizationId),
          eq(purchaseRequestLines.purchaseRequestId, row.purchaseRequestId),
        ),
      )
      .orderBy(asc(purchaseRequestLines.lineNo));
    return { rfq: { id: row.id, number: row.number, deadline: row.deadline }, lines };
  }
}
