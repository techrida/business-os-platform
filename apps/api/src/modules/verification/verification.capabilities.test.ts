// The case page offers review, edit, attach and remove from the `can` flags GET /verification/:id returns, not from
// role defaults. These flags come from the REAL `can()` on the case's ref, so they agree with the routes: sales sees
// edit controls on its own customer's case only, pmo reviews any case but cannot edit, a role without review never
// sees the review form, and a live grant that differs from the role default wins.
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { PartyOwnerPort } from './party-owner.port';
import { caseCapabilities, type Loaded } from './verification.service';

const TENANT = randomUUID();
const ENTITY = randomUUID();
const PARTY = randomUUID();
const OWNER = randomUUID();
const SCOPE = { tenantId: TENANT, organizationId: ENTITY };

function principal(role: RoleKey, userId: string, grants = DEFAULT_ROLE_PERMISSIONS[role]): Principal {
  return {
    userId,
    zitadelUserId: `z-${userId}`,
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: randomUUID(),
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(grants)) as Map<Permission, Scope>,
  };
}

function loaded(kind: 'customer' | 'vendor', ownerUserId: string | null): Loaded {
  const port = {
    writePermission: kind === 'customer' ? 'customer.write' : 'vendor.write',
    counterparty: (id: string) =>
      kind === 'customer' ? { customerPartyId: id } : { vendorPartyId: id },
  } as unknown as PartyOwnerPort;
  return {
    row: { tenantId: TENANT, partyId: PARTY, partyKind: kind } as Loaded['row'],
    partyOwnerUserId: ownerUserId,
    port,
  };
}

const NONE = { review: false, edit: false, attach: false, remove: false };

describe('caseCapabilities', () => {
  it('lets sales edit, attach and remove on its own customer, without review', () => {
    expect(caseCapabilities(principal('sales', OWNER), SCOPE, loaded('customer', OWNER))).toEqual({
      review: false,
      edit: true,
      attach: true,
      remove: true,
    });
  });

  it("offers sales nothing on a colleague's customer", () => {
    expect(
      caseCapabilities(principal('sales', randomUUID()), SCOPE, loaded('customer', OWNER)),
    ).toEqual(NONE);
  });

  it('lets pmo review a case it does not own, and nothing else', () => {
    expect(
      caseCapabilities(principal('pmo', randomUUID()), SCOPE, loaded('customer', OWNER)),
    ).toEqual({ ...NONE, review: true });
  });

  it('never offers review to a role without verification.review', () => {
    const can = caseCapabilities(
      principal('operations_head', randomUUID()),
      SCOPE,
      loaded('customer', OWNER),
    );
    expect(can.review).toBe(false);
    expect(can).toEqual(NONE);
  });

  it('follows the live grants, not the role default', () => {
    const { 'verification.read': _dropped, ...edited } = DEFAULT_ROLE_PERMISSIONS.sales;
    expect(
      caseCapabilities(principal('sales', OWNER, edited), SCOPE, loaded('customer', OWNER)),
    ).toEqual(NONE);
    const reviewing = { ...DEFAULT_ROLE_PERMISSIONS.operations_head, 'verification.review': 'all' as const };
    expect(
      caseCapabilities(
        principal('operations_head', randomUUID(), reviewing),
        SCOPE,
        loaded('customer', OWNER),
      ).review,
    ).toBe(true);
  });

  it('decides a vendor case on vendor.write', () => {
    const can = caseCapabilities(
      principal('procurement', randomUUID()),
      SCOPE,
      loaded('vendor', null),
    );
    expect(can.review).toBe(false);
    expect(can.edit).toBe(true);
    expect(can.remove).toBe(true);
    // Uploads are checked as documents.upload on the same case ref, which procurement holds at own scope: an
    // unowned vendor's case refuses the upload, so the control is not offered; the vendor's owner may attach.
    expect(can.attach).toBe(false);
    const buyer = randomUUID();
    expect(caseCapabilities(principal('procurement', buyer), SCOPE, loaded('vendor', buyer)).attach).toBe(
      true,
    );
  });

  it('offers nothing to a customer portal user', () => {
    const p = { ...principal('customer_user', randomUUID()), orgKind: 'customer' as const };
    expect(caseCapabilities(p, SCOPE, loaded('customer', OWNER))).toEqual(NONE);
  });
});
