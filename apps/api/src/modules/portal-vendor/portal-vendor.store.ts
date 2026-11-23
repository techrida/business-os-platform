// The vendor portal's reads on the real tables (P4 unit PV1). Every read of an entity-owned row is limited by
// `scopeWhereFor(p, table, 'portal.vendor.read')`, the SQL twin of `can()`: for a vendor user at `customer_org` that is
// the tenant, the acting entity and the vendor column = `p.partyId` (ADR 0027 §5); for anyone else it matches nothing.
//
// purchase_orders and vendor_bills name the vendor `vendor_id`, not `vendor_party_id`. The two are the same id
// (vendors.id is the vendor's party id, vendors_party_fk), so each table is handed to the scope helper through a small
// counterparty view that names `vendor_id` as its `vendorPartyId`. No hand-written party filter: the kernel helper
// still builds tenant + entity + party.
//
// A purchase order is read with its newest issued version only: the join is on `version = current_version`, which
// is 0 for a draft (no version row), so a draft is never reachable. An amendment waiting for approval writes no
// version (its proposal lives on the approval request), so the vendor keeps reading the last issued one.
// Vendors and KYB cases are tenant-level and keyed by the party id: they are read for `p.partyId` only.
import {
  purchaseOrders,
  purchaseOrderVersions,
  vendorBills,
  users,
  vendors,
  verificationCases,
} from '@bos/db';
import type { VendorStatus } from '@bos/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import type { Principal, ScopableTable } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import { receivedOf } from '../procurement/orders/purchase-order.writes';
import type { BillSource, ChecklistSource, PoSource } from './portal-vendor.views';

const ACTION = 'portal.vendor.read' as const;

/**
 * A table as the scope helper reads it, with `vendor_id` named as the vendor counterparty column. Only the three
 * columns are read (scopeWhereFor / scoped().forCounterparty); the cast is the one authz.service.ts uses.
 */
const vendorFacing = (t: typeof purchaseOrders | typeof vendorBills): ScopableTable =>
  ({
    tenantId: t.tenantId,
    organizationId: t.organizationId,
    vendorPartyId: t.vendorId,
  }) as unknown as ScopableTable;

const PURCHASE_ORDERS = vendorFacing(purchaseOrders);
const VENDOR_BILLS = vendorFacing(vendorBills);

/** One purchase order the caller may read, with its newest issued version and the entity it lives in. */
export type PoRecord = PoSource & TxScope;

export interface VendorPortalStore {
  /** The caller's own vendor status; undefined when its party has no vendor record. */
  vendorStatus(p: Principal): Promise<VendorStatus | undefined>;
  /** The checklist of the caller's own KYB case; undefined when no case is open yet. */
  kybChecklist(p: Principal): Promise<ChecklistSource[] | undefined>;
  /** When a change of the vendor's details reset its KYB case and who made it; null when the case never was reset. */
  kybDetailsChanged(p: Principal): Promise<{ at: string; by: string | null } | null>;
  /** Every purchase order `p` may read that has an issued version, each with its newest version. */
  listPurchaseOrders(p: Principal): Promise<PoRecord[]>;
  /** One purchase order `p` may read with its newest issued version; undefined when out of reach or a draft. */
  loadPurchaseOrder(p: Principal, id: string): Promise<PoRecord | undefined>;
  /** Confirmed received quantity per PO line (receipt drafts left out), read in the order's own entity. */
  confirmedReceipts(scope: TxScope, poId: string): Promise<Map<string, string>>;
  /** Every bill `p` may read, newest invoice first. */
  listBills(p: Principal): Promise<BillSource[]>;
  /** One bill `p` may read; undefined when out of reach. */
  loadBill(p: Principal, id: string): Promise<BillSource | undefined>;
}

export const VENDOR_PORTAL_STORE = Symbol('VENDOR_PORTAL_STORE');

/** The newest issued version of an order: same tenant, entity and order, at its current version. */
const currentVersionOf = and(
  eq(purchaseOrderVersions.tenantId, purchaseOrders.tenantId),
  eq(purchaseOrderVersions.organizationId, purchaseOrders.organizationId),
  eq(purchaseOrderVersions.purchaseOrderId, purchaseOrders.id),
  eq(purchaseOrderVersions.version, purchaseOrders.currentVersion),
);

const poColumns = {
  id: purchaseOrders.id,
  tenantId: purchaseOrders.tenantId,
  organizationId: purchaseOrders.organizationId,
  number: purchaseOrders.number,
  status: purchaseOrders.status,
  version: {
    id: purchaseOrderVersions.id,
    version: purchaseOrderVersions.version,
    total: purchaseOrderVersions.total,
    snapshot: purchaseOrderVersions.snapshot,
    createdAt: purchaseOrderVersions.createdAt,
  },
};

const billColumns = {
  id: vendorBills.id,
  kind: vendorBills.kind,
  number: vendorBills.number,
  vendorInvoiceNo: vendorBills.vendorInvoiceNo,
  invoiceDate: vendorBills.invoiceDate,
  currency: vendorBills.currency,
  payableTotal: vendorBills.payableTotal,
  tdsTotal: vendorBills.tdsTotal,
  status: vendorBills.status,
};

/** Bills a vendor may be shown at all: numbered bills that are not voided (the mapper repeats the rule). */
const showableBill = and(
  eq(vendorBills.kind, 'bill'),
  isNotNull(vendorBills.number),
  ne(vendorBills.status, 'voided'),
  ne(vendorBills.status, 'discarded'),
);

@Injectable()
export class DrizzleVendorPortalStore implements VendorPortalStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async vendorStatus(p: Principal): Promise<VendorStatus | undefined> {
    if (p.partyId === null || p.partyId === '') return undefined;
    const [row] = await this.db
      .select({ status: vendors.status })
      .from(vendors)
      .where(and(eq(vendors.tenantId, p.tenantId), eq(vendors.id, p.partyId)))
      .limit(1);
    return row?.status;
  }

  async kybChecklist(p: Principal): Promise<ChecklistSource[] | undefined> {
    if (p.partyId === null || p.partyId === '') return undefined;
    const [row] = await this.db
      .select({ checklist: verificationCases.checklist })
      .from(verificationCases)
      .where(
        and(
          eq(verificationCases.tenantId, p.tenantId),
          eq(verificationCases.partyId, p.partyId),
          eq(verificationCases.partyKind, 'vendor'),
        ),
      )
      .limit(1);
    if (row === undefined) return undefined;
    return Array.isArray(row.checklist) ? (row.checklist as ChecklistSource[]) : [];
  }

  async kybDetailsChanged(p: Principal): Promise<{ at: string; by: string | null } | null> {
    if (p.partyId === null || p.partyId === '') return null;
    const [row] = await this.db
      .select({ at: verificationCases.identityResetAt, by: users.displayName })
      .from(verificationCases)
      .leftJoin(
        users,
        and(
          eq(users.tenantId, verificationCases.tenantId),
          eq(users.id, verificationCases.identityResetByUserId),
        ),
      )
      .where(
        and(
          eq(verificationCases.tenantId, p.tenantId),
          eq(verificationCases.partyId, p.partyId),
          eq(verificationCases.partyKind, 'vendor'),
          // Only while the documents are still to be sent again: a submitted or decided case drops the note.
          inArray(verificationCases.status, ['draft', 'rejected']),
        ),
      )
      .limit(1);
    return row?.at ? { at: row.at.toISOString(), by: row.by ?? null } : null;
  }

  async listPurchaseOrders(p: Principal): Promise<PoRecord[]> {
    const rows = await this.db
      .select(poColumns)
      .from(purchaseOrders)
      .innerJoin(purchaseOrderVersions, currentVersionOf)
      .where(scopeWhereFor(p, PURCHASE_ORDERS, ACTION))
      .orderBy(desc(purchaseOrderVersions.createdAt), desc(purchaseOrders.number));
    return rows;
  }

  async loadPurchaseOrder(p: Principal, id: string): Promise<PoRecord | undefined> {
    const [row] = await this.db
      .select(poColumns)
      .from(purchaseOrders)
      .innerJoin(purchaseOrderVersions, currentVersionOf)
      .where(and(scopeWhereFor(p, PURCHASE_ORDERS, ACTION), eq(purchaseOrders.id, id)))
      .limit(1);
    return row;
  }

  async confirmedReceipts(scope: TxScope, poId: string): Promise<Map<string, string>> {
    // receivedOf runs on a transaction; a read-only one here (no write, so no audit row).
    const received = await this.db.transaction((tx) => receivedOf(tx, scope, poId));
    return received.confirmed;
  }

  async listBills(p: Principal): Promise<BillSource[]> {
    return this.db
      .select(billColumns)
      .from(vendorBills)
      .where(and(scopeWhereFor(p, VENDOR_BILLS, ACTION), showableBill))
      .orderBy(desc(vendorBills.invoiceDate), desc(vendorBills.number));
  }

  async loadBill(p: Principal, id: string): Promise<BillSource | undefined> {
    const [row] = await this.db
      .select(billColumns)
      .from(vendorBills)
      .where(and(scopeWhereFor(p, VENDOR_BILLS, ACTION), eq(vendorBills.id, id)))
      .limit(1);
    return row;
  }
}
