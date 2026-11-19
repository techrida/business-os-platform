// Unit tests of mayEnterBill, the `can.enterBill` flag of the purchase order detail (U18 #12): the PO page offers
// Enter bill only to a caller the bill entry route would let in, on an order a bill can be entered against.
import {
  DEFAULT_ROLE_PERMISSIONS,
  PO_STATUSES,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import { BILLABLE_PO_STATUSES } from '../../payables/bills/vendor-bill.rules';
import { mayEnterBill } from './purchase-orders.service';

const ORG = '11111111-1111-4111-8111-111111111111';

const principalOf = (roles: RoleKey[], over: Partial<Principal> = {}): Principal => ({
  userId: '22222222-2222-4222-8222-222222222222',
  zitadelUserId: 'z-1',
  tenantId: ORG,
  organizationId: ORG,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles,
  departmentId: null,
  status: 'active',
  grants: new Map(
    roles.flatMap((r) => Object.entries(DEFAULT_ROLE_PERMISSIONS[r])) as [Permission, Scope][],
  ),
  ...over,
});

describe('mayEnterBill', () => {
  it('is true only for a caller holding payables.bill.enter, on a billable order', () => {
    const both = principalOf(['procurement', 'accountant']);
    for (const status of PO_STATUSES) {
      expect(mayEnterBill(both, status)).toBe(
        (BILLABLE_PO_STATUSES as readonly string[]).includes(status),
      );
    }
  });

  it('is false for procurement alone, who opens the order but cannot enter bills', () => {
    expect(mayEnterBill(principalOf(['procurement']), 'issued')).toBe(false);
  });

  it('is false for an inactive user and for a portal caller', () => {
    expect(mayEnterBill(principalOf(['founder'], { status: 'inactive' }), 'issued')).toBe(false);
    expect(mayEnterBill(principalOf(['founder'], { orgKind: 'vendor' }), 'issued')).toBe(false);
    expect(mayEnterBill(principalOf(['founder']), 'issued')).toBe(true);
  });
});
