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

function principal(
  role: RoleKey,
  userId: string,
  grants = DEFAULT_ROLE_PERMISSIONS[role],
): Principal {
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

function loaded(
  kind: 'customer' | 'vendor',
  ownerUserId: string | null,
  submittedByUserId: string | null = null,
): Loaded {
  const port = {
    writePermission: kind === 'customer' ? 'customer.write' : 'vendor.write',
    counterparty: (id: string) =>
      kind === 'customer' ? { customerPartyId: id } : { vendorPartyId: id },
  } as unknown as PartyOwnerPort;
  return {
    row: { tenantId: TENANT, partyId: PARTY, partyKind: kind, submittedByUserId } as Loaded['row'],
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
    const reviewing = {
      ...DEFAULT_ROLE_PERMISSIONS.operations_head,
      'verification.review': 'all' as const,
    };
    expect(
      caseCapabilities(
        principal('operations_head', randomUUID(), reviewing),
        SCOPE,
        loaded('customer', OWNER),
      ).review,
    ).toBe(true);
  });

  it('decides a vendor case on vendor.write and lets procurement attach to any visible vendor case (U18 Q9 b)', () => {
    const buyer = randomUUID();
    // Unowned vendor and colleague-owned vendor: procurement holds vendor.write + verification.read (all)
    // plus documents.upload (own), so attach is offered alongside edit and remove.
    for (const ownerUserId of [null, OWNER, buyer]) {
      const can = caseCapabilities(
        principal('procurement', buyer),
        SCOPE,
        loaded('vendor', ownerUserId),
      );
      expect(can).toEqual({ review: false, edit: true, attach: true, remove: true });
    }

    // Without read on the case (no verification.read, or own-only on another owner's vendor), attach is refused.
    const { 'verification.read': _droppedRead, ...noRead } = DEFAULT_ROLE_PERMISSIONS.procurement;
    expect(
      caseCapabilities(principal('procurement', buyer, noRead), SCOPE, loaded('vendor', OWNER)),
    ).toEqual(NONE);
    expect(
      caseCapabilities(
        principal('procurement', buyer, {
          ...DEFAULT_ROLE_PERMISSIONS.procurement,
          'verification.read': 'own',
        }),
        SCOPE,
        loaded('vendor', OWNER),
      ),
    ).toEqual(NONE);

    // Without vendor.write (even with verification.read all and documents.upload own), attach is refused.
    expect(caseCapabilities(principal('pmo', buyer), SCOPE, loaded('vendor', OWNER)).attach).toBe(
      false,
    );
    expect(
      caseCapabilities(principal('operations_head', buyer), SCOPE, loaded('vendor', OWNER)).attach,
    ).toBe(false);

    // Another tenant or another legal entity is still refused.
    expect(
      caseCapabilities(
        { ...principal('procurement', buyer), tenantId: randomUUID() },
        SCOPE,
        loaded('vendor', OWNER),
      ),
    ).toEqual(NONE);
    expect(
      caseCapabilities(
        { ...principal('procurement', buyer), organizationId: randomUUID() },
        SCOPE,
        loaded('vendor', OWNER),
      ),
    ).toEqual(NONE);

    // Customer cases are unaffected: a non-owner with customer.write + verification.read (all) and
    // documents.upload (own) still cannot attach to another owner's customer case.
    const salesReadAll = {
      ...DEFAULT_ROLE_PERMISSIONS.sales,
      'verification.read': 'all' as const,
    };
    const customerCan = caseCapabilities(
      principal('sales', buyer, salesReadAll),
      SCOPE,
      loaded('customer', OWNER),
    );
    expect(customerCan).toEqual({ review: false, edit: true, attach: false, remove: true });
  });

  it('never offers review to the person who submitted the case, a Founder included (separation of duties)', () => {
    const submitter = randomUUID();
    const founder = caseCapabilities(
      principal('founder', submitter),
      SCOPE,
      loaded('vendor', null, submitter),
    );
    // Only review is withheld: the submitter keeps what the kind's write permission gives.
    expect(founder).toEqual({ review: false, edit: true, attach: true, remove: true });
    expect(
      caseCapabilities(principal('founder', randomUUID()), SCOPE, loaded('vendor', null, submitter))
        .review,
    ).toBe(true);
    expect(
      caseCapabilities(principal('pmo', submitter), SCOPE, loaded('customer', OWNER, submitter))
        .review,
    ).toBe(false);
  });

  it('offers nothing to a customer portal user', () => {
    const p = { ...principal('customer_user', randomUUID()), orgKind: 'customer' as const };
    expect(caseCapabilities(p, SCOPE, loaded('customer', OWNER))).toEqual(NONE);
  });
});
