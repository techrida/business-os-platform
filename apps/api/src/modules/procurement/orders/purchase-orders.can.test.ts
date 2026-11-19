// Unit tests of mayEnterBill, the `can.enterBill` flag of the purchase order detail (U18 #12): the PO page offers
// Enter bill only to a caller the bill form's progress read would let in (payables.bill.enter on the order's purchase
// request), on an order a bill can be entered against.
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
const ME = '22222222-2222-4222-8222-222222222222';
const SOMEONE_ELSE = '33333333-3333-4333-8333-333333333333';
const DEPT = '44444444-4444-4444-8444-444444444444';

const principalOf = (roles: RoleKey[], over: Partial<Principal> = {}): Principal => ({
  userId: ME,
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

/** The purchase request an order was raised from, by `requesterUserId`. */
const requestOf = (requesterUserId: string) => ({
  tenantId: ORG,
  organizationId: ORG,
  requesterUserId,
  departmentId: DEPT,
});
const THEIRS = requestOf(SOMEONE_ELSE);

describe('mayEnterBill', () => {
  it('is true only for a caller holding payables.bill.enter, on a billable order', () => {
    const both = principalOf(['procurement', 'accountant']);
    for (const status of PO_STATUSES) {
      expect(mayEnterBill(both, status, THEIRS)).toBe(
        (BILLABLE_PO_STATUSES as readonly string[]).includes(status),
      );
    }
  });

  it('is false for procurement alone, who opens the order but cannot enter bills', () => {
    expect(mayEnterBill(principalOf(['procurement']), 'issued', THEIRS)).toBe(false);
  });

  it('is false for an inactive user and for a portal caller', () => {
    expect(mayEnterBill(principalOf(['founder'], { status: 'inactive' }), 'issued', THEIRS)).toBe(
      false,
    );
    expect(mayEnterBill(principalOf(['founder'], { orgKind: 'vendor' }), 'issued', THEIRS)).toBe(
      false,
    );
    expect(mayEnterBill(principalOf(['founder']), 'issued', THEIRS)).toBe(true);
  });
});
