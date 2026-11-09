// The vendor portal's RFQ read rules (P4 unit PV3), for the "submit a quotation" screen. Serves the NFR "a vendor sees
// only what we meant to show" (done check 13):
// - only a vendor principal with a party gets in (assertVendorCaller, 403 before any query);
// - the vendor needs the full capability, decided live from its vendor status: a pending_kyc vendor (onboarding only)
//   and a suspended one (read only) are refused with 403, as a vendor that cannot submit has no use for an RFQ;
// - the store limits every read to open RFQs the caller's own vendor is invited to in the acting entity; an uninvited,
//   closed, cancelled, other-entity or unknown id is the same 404 (one body), so existence never leaks;
// - every view is built by the strict mappers in portal-vendor-rfq.views.ts, never from a row.
import type { VendorPortalRfqListItem, VendorPortalRfqView } from '@bos/contracts';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { Principal } from '../../platform/authz/principal';
import {
  assertVendorCaller,
  assertVendorCapability,
  vendorPortalAccess,
  VendorPortalCaller,
} from '../portal/vendor-portal.caller';
import { VENDOR_PORTAL_RFQ_STORE, type VendorPortalRfqStore } from './portal-vendor-rfq.store';
import { toRfqListItem, toRfqView } from './portal-vendor-rfq.views';
import { VENDOR_PORTAL_STORE, type VendorPortalStore } from './portal-vendor.store';

/** The one 404 of the vendor portal: an uninvited, hidden or unknown id all answer this body. */
const notFound = () => new NotFoundException('Not found');

@Injectable()
export class VendorPortalRfqService {
  constructor(
    private readonly caller: VendorPortalCaller,
    @Inject(VENDOR_PORTAL_STORE) private readonly vendors: VendorPortalStore,
    @Inject(VENDOR_PORTAL_RFQ_STORE) private readonly store: VendorPortalRfqStore,
  ) {}

  /** The open RFQs the caller's vendor is invited to in the acting entity. */
  async listRfqs(): Promise<VendorPortalRfqListItem[]> {
    const p = await this.access();
    return (await this.store.listOpenRfqs(p)).map(toRfqListItem);
  }

  /** One open RFQ with the lines to quote. 404 unless the caller's vendor is invited and the RFQ is open. */
  async getRfq(id: string): Promise<VendorPortalRfqView> {
    const p = await this.access();
    const found = await this.store.loadOpenRfq(p, id);
    if (found === undefined) throw notFound();
    return toRfqView(found.rfq, found.lines);
  }

  /**
   * 403 unless the caller is a vendor principal with the full capability (the one that may submit a quotation).
   * Reads only the caller's own vendor row, before any id is looked at, so a refused vendor learns nothing about
   * other rows. A party with no vendor record has no capability at all.
   */
  private async access(): Promise<Principal> {
    const p = this.caller.current();
    // A staff or customer principal is refused before any query.
    assertVendorCaller(p);
    const status = await this.vendors.vendorStatus(p);
    if (status === undefined) {
      assertVendorCapability('none', 'submit');
      throw new Error('unreachable: no capability allows anything');
    }
    assertVendorCapability(vendorPortalAccess(p, status).capability, 'submit');
    return p;
  }
}
