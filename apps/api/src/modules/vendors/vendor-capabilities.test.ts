// Unit tests of vendorCapabilities (no database).
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
  type VendorStatus,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/can';
import { vendorCapabilities } from './vendors.service';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '00000000-0000-4000-8000-000000000002';
const VENDOR_ID = '00000000-0000-4000-8000-000000000010';
const CREATOR = '00000000-0000-4000-8000-000000000003';
const REVIEWER = '00000000-0000-4000-8000-000000000004';

function principalOf(role: RoleKey, over: Partial<Principal> = {}): Principal {
  return {
    userId: REVIEWER,
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

const vendorRow = (status: VendorStatus, createdBy: string = CREATOR) => ({
  id: VENDOR_ID,
  tenantId: TENANT,
  ownerUserId: CREATOR,
  createdBy,
  status,
});

describe('vendorCapabilities', () => {
  it('reflects procurement write + bank propose grants without activate', () => {
    const procurement = principalOf('procurement', { userId: CREATOR });
    expect(vendorCapabilities(procurement, vendorRow('under_review', CREATOR))).toEqual({
      write: true,
      activate: false,
      suspend: false,
      block: false,
      archive: false,
      activateBlockedBySod: false,
      proposeBank: true,
      verifyBank: false,
    });
  });

  it('reflects finance bank verify grant without write or activate', () => {
    const finance = principalOf('finance', { userId: REVIEWER });
    expect(vendorCapabilities(finance, vendorRow('approved', CREATOR))).toEqual({
      write: false,
      activate: false,
      suspend: false,
      block: false,
      archive: false,
      activateBlockedBySod: false,
      proposeBank: false,
      verifyBank: true,
    });
  });

  it('enforces creator SoD on activate for both under_review and suspended', () => {
    const creatorFounder = principalOf('founder', { userId: CREATOR });
    const reviewerFounder = principalOf('founder', { userId: REVIEWER });

    for (const status of ['under_review', 'suspended'] as const) {
      expect(vendorCapabilities(creatorFounder, vendorRow(status, CREATOR)), status).toMatchObject({
        activate: false,
        activateBlockedBySod: true,
      });
      expect(vendorCapabilities(reviewerFounder, vendorRow(status, CREATOR)), status).toMatchObject(
        {
          activate: true,
          activateBlockedBySod: false,
        },
      );
    }
  });

  it('matches lifecycle transitions for suspend, block and archive', () => {
    const founder = principalOf('founder', { userId: REVIEWER });
    expect(vendorCapabilities(founder, vendorRow('approved'))).toMatchObject({
      activate: false,
      suspend: true,
      block: true,
      archive: false,
      activateBlockedBySod: false,
    });
    expect(vendorCapabilities(founder, vendorRow('suspended'))).toMatchObject({
      activate: true,
      suspend: false,
      block: true,
      archive: false,
    });
    expect(vendorCapabilities(founder, vendorRow('blocked'))).toMatchObject({
      write: false,
      proposeBank: false,
      activate: false,
      suspend: false,
      block: false,
      archive: true,
    });
    expect(vendorCapabilities(founder, vendorRow('archived'))).toMatchObject({
      write: false,
      proposeBank: false,
      activate: false,
      suspend: false,
      block: false,
      archive: false,
    });
  });

  it('blocks activation when KYB is not approved or tax clearance has expired', () => {
    const reviewer = principalOf('founder', { userId: REVIEWER });
    expect(
      vendorCapabilities(reviewer, vendorRow('under_review', CREATOR), {
        approved: false,
        kycExpired: false,
      }),
    ).toMatchObject({
      activate: false,
      activateBlockedBySod: false,
      activateBlockedByKyb: true,
      activateBlockedByKycExpired: false,
    });
    expect(
      vendorCapabilities(reviewer, vendorRow('under_review', CREATOR), {
        approved: true,
        kycExpired: true,
      }),
    ).toMatchObject({
      activate: false,
      activateBlockedBySod: false,
      activateBlockedByKyb: false,
      activateBlockedByKycExpired: true,
    });
    expect(
      vendorCapabilities(reviewer, vendorRow('under_review', CREATOR), {
        approved: true,
        kycExpired: false,
      }),
    ).toMatchObject({
      activate: true,
      activateBlockedBySod: false,
      activateBlockedByKyb: false,
      activateBlockedByKycExpired: false,
    });
  });

  it('denies everything for a non-staff portal principal', () => {
    const portal = principalOf('founder', { orgKind: 'vendor', partyId: VENDOR_ID });
    expect(vendorCapabilities(portal, vendorRow('under_review', CREATOR))).toEqual({
      write: false,
      activate: false,
      suspend: false,
      block: false,
      archive: false,
      activateBlockedBySod: false,
      proposeBank: false,
      verifyBank: false,
    });
  });
});
