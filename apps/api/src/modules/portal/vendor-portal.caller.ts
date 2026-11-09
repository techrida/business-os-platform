// Who is calling the vendor portal routes (K4), the vendor twin of portal.caller.ts. Serves the NFR "a vendor sees
// only what we meant to show": the vendor portal answers only vendor principals that carry a party (the party comes
// from app.idp_orgs kind vendor, ADR 0027 section 2). A staff founder holds the portal permissions at `all`, so the
// vendor portal services (PV1, PV2) run `assertVendorCaller` before any query, whatever caller they are given.
//
// What a vendor may do also depends on its status (A4 section 5, rule 2; CT's vendorPortalCapability): a vendor whose
// KYC is pending gets onboarding-only access, so it may upload KYC documents but is refused purchase orders and bills
// (done check 13). The services load the vendor's status and pass it to `vendorPortalAccess`, then gate each route
// with `assertVendorCapability`.
import {
  type VendorPortalCapability,
  type VendorStatus,
  vendorPortalCapability,
} from '@bos/contracts';
import { ForbiddenException, Injectable } from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';

/** Same body as AuthzService.assert and assertCustomerCaller. */
const forbidden = () =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });

/** 403 unless `p` is a vendor portal principal with a party. Returns the vendor's party id. */
export function assertVendorCaller(p: Principal): string {
  if (p.orgKind !== 'vendor' || p.partyId === null || p.partyId === '') throw forbidden();
  return p.partyId;
}

/**
 * What a vendor portal route needs:
 * - `onboarding`: the onboarding view and KYC uploads (a suspended vendor renews an expired clearance here too);
 * - `read`: purchase orders and bills;
 * - `submit`: quotation, bill and bank-change submissions.
 */
export type VendorPortalNeed = 'onboarding' | 'read' | 'submit';

const ALLOWED: Readonly<Record<VendorPortalCapability, readonly VendorPortalNeed[]>> = {
  onboarding_only: ['onboarding'],
  full: ['onboarding', 'read', 'submit'],
  read_only: ['onboarding', 'read'],
  none: [],
};

/** The vendor caller's party and its capability for a vendor in `status`. 403 for any other caller. */
export function vendorPortalAccess(
  p: Principal,
  status: VendorStatus,
): { vendorPartyId: string; capability: VendorPortalCapability } {
  const vendorPartyId = assertVendorCaller(p);
  return { vendorPartyId, capability: vendorPortalCapability(status) };
}

/** 403 unless `capability` allows `need`. */
export function assertVendorCapability(
  capability: VendorPortalCapability,
  need: VendorPortalNeed,
): void {
  if (!ALLOWED[capability].includes(need)) throw forbidden();
}

@Injectable()
export class VendorPortalCaller {
  /** The current principal. The vendor portal services check it with assertVendorCaller before reading anything. */
  current(): Principal {
    return principal();
  }
}
