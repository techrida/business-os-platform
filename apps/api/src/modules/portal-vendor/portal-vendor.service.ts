// The vendor portal's read rules (P4 unit PV1). Serves the NFR "a vendor sees only what we meant to show"
// (done check 13):
// - only a vendor principal with a party gets in (assertVendorCaller, 403 before any query);
// - what it may do is decided live from its vendor status (vendorPortalAccess): onboarding is open to every vendor
//   with a vendor record; purchase orders and bills need `read`, so a pending_kyc vendor gets 403 there;
// - the store limits every read to the caller's tenant, acting entity and own party; a foreign, hidden or unknown
//   id is the same 404 on every route (one body), so existence never leaks;
// - a purchase order is shown only at its newest issued version; a draft is a 404;
// - every view is built by the strict mappers in portal-vendor.views.ts, never from a row.
// The PDF link: the version's rendered document (owner type `purchase_order_version`, P3b renders it) is served only
// when its newest not-rejected file version scanned clean; otherwise the same 404. DocumentsService.issueLinkForOwner
// asks no permission of its own (vendors hold no `documents.read`), so this service is the whole authorization.
import type {
  SignedLinkDto,
  VendorPortalBillView,
  VendorPortalOnboardingView,
  VendorPortalPurchaseOrderListItem,
  VendorPortalPurchaseOrderView,
  VendorStatus,
} from '@bos/contracts';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { Principal } from '../../platform/authz/principal';
import type { TxScope } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import {
  assertVendorCaller,
  assertVendorCapability,
  vendorPortalAccess,
  VendorPortalCaller,
  type VendorPortalNeed,
} from '../portal/vendor-portal.caller';
import { kathmanduDay } from '../quotations/reference/reference.types';
import { type PoRecord, VENDOR_PORTAL_STORE, type VendorPortalStore } from './portal-vendor.store';
import {
  toBillView,
  toOnboardingView,
  toPurchaseOrderListItem,
  toPurchaseOrderView,
} from './portal-vendor.views';

/** The document owner type of a purchase order version's rendered PDF (P3b registers its policy). */
export const PO_VERSION_OWNER_TYPE = 'purchase_order_version';

/** The one 404 of the vendor portal: a foreign, hidden, unknown or unrendered id all answer this body. */
const notFound = () => new NotFoundException('Not found');

/** Injection token for a test clock (the onboarding view reads expiry against today in Kathmandu). */
export const VENDOR_PORTAL_CLOCK = Symbol('VENDOR_PORTAL_CLOCK');

@Injectable()
export class VendorPortalService {
  constructor(
    private readonly caller: VendorPortalCaller,
    @Inject(VENDOR_PORTAL_STORE) private readonly store: VendorPortalStore,
    private readonly documents: DocumentsService,
    @Inject(VENDOR_PORTAL_CLOCK) private readonly clock: () => Date,
  ) {}

  /** The caller's onboarding status and KYB checklist. Open to every vendor with a record, pending_kyc included. */
  async onboarding(): Promise<VendorPortalOnboardingView> {
    const { p, status } = await this.access('onboarding');
    const checklist = await this.store.kybChecklist(p);
    const detailsChanged = await this.store.kybDetailsChanged(p);
    return toOnboardingView(status, checklist, kathmanduDay(this.clock()), detailsChanged);
  }

  /** The caller's purchase orders in the acting entity, each at its newest issued version. */
  async listPurchaseOrders(): Promise<VendorPortalPurchaseOrderListItem[]> {
    const { p } = await this.access('read');
    const items: VendorPortalPurchaseOrderListItem[] = [];
    for (const po of await this.store.listPurchaseOrders(p)) {
      // Receipts matter to the list only for a pending amendment, whose status they give.
      const received =
        po.status === 'amendment_pending'
          ? await this.store.confirmedReceipts(scopeOf(po), po.id)
          : new Map<string, string>();
      const item = toPurchaseOrderListItem(po, received);
      if (item !== undefined) items.push(item);
    }
    return items;
  }

  /** One purchase order at its newest issued version. 404 unless it is the caller's and issued. */
  async getPurchaseOrder(id: string): Promise<VendorPortalPurchaseOrderView> {
    const { p } = await this.access('read');
    const po = await this.store.loadPurchaseOrder(p, id);
    if (po === undefined) throw notFound();
    const received = await this.store.confirmedReceipts(scopeOf(po), po.id);
    const view = toPurchaseOrderView(po, received, await this.cleanFile(po));
    if (view === undefined) throw notFound();
    return view;
  }

  /**
   * A short-lived signed link to the clean PDF of the order's newest issued version. 404 unless the order is the
   * caller's and issued and the PDF exists and scanned clean; the document module then re-checks owner and scan.
   * The link is scoped by the order's own tenant and entity, read from its row.
   */
  async purchaseOrderPdfLink(id: string): Promise<SignedLinkDto> {
    const { p } = await this.access('read');
    const po = await this.store.loadPurchaseOrder(p, id);
    if (po === undefined) throw notFound();
    const received = await this.store.confirmedReceipts(scopeOf(po), po.id);
    if (toPurchaseOrderListItem(po, received) === undefined) throw notFound();
    const file = await this.cleanFile(po);
    if (file === null) throw notFound();
    try {
      return await this.documents.issueLinkForOwner(
        scopeOf(po),
        { ownerType: PO_VERSION_OWNER_TYPE, ownerId: po.version.id },
        file.documentId,
      );
    } catch (error) {
      // The document module's own 404 (or an owner type not registered yet) becomes the portal's one body.
      if (error instanceof NotFoundException) throw notFound();
      throw error;
    }
  }

  /** The caller's bills in the acting entity, with the coarse status. */
  async listBills(): Promise<VendorPortalBillView[]> {
    const { p } = await this.access('read');
    const views: VendorPortalBillView[] = [];
    for (const bill of await this.store.listBills(p)) {
      const view = toBillView(bill);
      if (view !== undefined) views.push(view);
    }
    return views;
  }

  /** One bill. 404 unless it is the caller's and shown (not voided, not a credit note, numbered). */
  async getBill(id: string): Promise<VendorPortalBillView> {
    const { p } = await this.access('read');
    const bill = await this.store.loadBill(p, id);
    const view = bill === undefined ? undefined : toBillView(bill);
    if (view === undefined) throw notFound();
    return view;
  }

  /**
   * 403 unless the caller is a vendor principal whose status allows `need`. Reads only the caller's own vendor row,
   * before any id is looked at, so a refused vendor learns nothing about other rows. A party with no vendor record
   * has no capability at all.
   */
  private async access(need: VendorPortalNeed): Promise<{ p: Principal; status: VendorStatus }> {
    const p = this.caller.current();
    // A staff or customer principal is refused before any query.
    assertVendorCaller(p);
    const status = await this.store.vendorStatus(p);
    if (status === undefined) {
      assertVendorCapability('none', need);
      throw new Error('unreachable: no capability allows anything');
    }
    assertVendorCapability(vendorPortalAccess(p, status).capability, need);
    return { p, status };
  }

  /**
   * The rendered PDF of the order's newest issued version when its newest not-rejected file version is clean, else
   * null. Read through listForOwner, which asks no permission: this service authorized the caller already.
   */
  private async cleanFile(
    po: PoRecord,
  ): Promise<{ documentId: string; filename: string; sha256: string } | null> {
    const versions = await this.documents.listForOwner(
      scopeOf(po),
      PO_VERSION_OWNER_TYPE,
      po.version.id,
    );
    // listForOwner is ordered oldest first; the newest upload that was not refused decides.
    const newest = versions.filter((v) => v.status !== 'rejected').at(-1);
    if (newest === undefined || newest.status !== 'clean' || newest.sha256 === null) return null;
    return { documentId: newest.documentId, filename: newest.filename, sha256: newest.sha256 };
  }
}

const scopeOf = (po: PoRecord): TxScope => ({
  tenantId: po.tenantId,
  organizationId: po.organizationId,
});
