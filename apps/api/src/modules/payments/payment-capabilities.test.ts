// Unit tests of paymentCapabilities (no database).
import {
  DEFAULT_ROLE_PERMISSIONS,
  type PaymentStatus,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/can';
import { paymentCapabilities } from './payments.service';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '00000000-0000-4000-8000-000000000002';
const FINANCE = '00000000-0000-4000-8000-000000000003';
const ACCOUNTANT = '00000000-0000-4000-8000-000000000004';
const CUSTOMER = '00000000-0000-4000-8000-000000000005';

function principalOf(role: RoleKey, over: Partial<Principal> = {}): Principal {
  return {
    userId: FINANCE,
    zitadelUserId: 'z-user',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: '00000000-0000-4000-8000-000000000009',
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
    ...over,
  };
}

const paymentRow = (status: PaymentStatus, submittedBy: string | null = ACCOUNTANT) => ({
  tenantId: TENANT,
  organizationId: ENTITY,
  customerPartyId: CUSTOMER,
  submittedBy,
  status,
});

describe('paymentCapabilities', () => {
  it('allows finance to verify and reject another user’s submitted payment', () => {
    const finance = principalOf('finance', { userId: FINANCE });
    expect(paymentCapabilities(finance, paymentRow('submitted', ACCOUNTANT))).toEqual({
      verify: true,
      reject: true,
      reverse: false,
      verifyBlockedBySod: false,
    });
  });

  it('blocks self-verification with verifyBlockedBySod while still allowing reject', () => {
    const finance = principalOf('finance', { userId: FINANCE });
    expect(paymentCapabilities(finance, paymentRow('submitted', FINANCE))).toEqual({
      verify: false,
      reject: true,
      reverse: false,
      verifyBlockedBySod: true,
    });
  });

  it('allows reverse only on verified payments for callers with payment.verify', () => {
    const finance = principalOf('finance', { userId: FINANCE });
    expect(paymentCapabilities(finance, paymentRow('verified', ACCOUNTANT))).toEqual({
      verify: false,
      reject: false,
      reverse: true,
      verifyBlockedBySod: false,
    });
    for (const status of ['rejected', 'withdrawn', 'reversed'] as const) {
      expect(paymentCapabilities(finance, paymentRow(status, ACCOUNTANT)), status).toEqual({
        verify: false,
        reject: false,
        reverse: false,
        verifyBlockedBySod: false,
      });
    }
  });

  it('denies all actions without payment.verify or for an inactive user', () => {
    const accountant = principalOf('accountant', { userId: ACCOUNTANT });
    expect(paymentCapabilities(accountant, paymentRow('submitted', FINANCE))).toEqual({
      verify: false,
      reject: false,
      reverse: false,
      verifyBlockedBySod: false,
    });
    expect(paymentCapabilities(accountant, paymentRow('verified', FINANCE))).toEqual({
      verify: false,
      reject: false,
      reverse: false,
      verifyBlockedBySod: false,
    });
    const inactive = principalOf('finance', { userId: FINANCE, status: 'inactive' });
    expect(paymentCapabilities(inactive, paymentRow('submitted', ACCOUNTANT))).toEqual({
      verify: false,
      reject: false,
      reverse: false,
      verifyBlockedBySod: false,
    });
  });
});
