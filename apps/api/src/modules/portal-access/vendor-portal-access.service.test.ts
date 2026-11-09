// Unit tests of VendorPortalAccessService (K4) with a fake store and a fake ZITADEL client: the vendor status gate
// (approved, or pending_kyc with onboarding-only access; any other status is a 409 before ZITADEL is called), the
// org of kind vendor and the vendor_user role, and that a retry reuses the org and the user. The SQL side is covered
// by vendor-portal-access.integration.test.ts.
import type { Permission, Scope, VendorStatus } from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Actor, TxScope } from '../../platform/db/tx';
import {
  PORTAL_LOGIN_POLICY,
  type CreateHumanInput,
  type OrgLoginPolicyPatch,
  type ZitadelAdminClient,
  type ZitadelUser,
} from '../../platform/users/zitadel-admin.client';
import type { PortalAccessCaller } from './portal-access.caller';
import { VendorPortalAccessService, portalOrgName } from './portal-access.service';
import {
  VendorPortalAccessStore,
  type IdpOrgOwner,
  type VendorFinishInput,
  type VendorPortalAccessDto,
  type VendorPortalTarget,
  type VendorRow,
} from './portal-access.types';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '00000000-0000-4000-8000-000000000002';
const VENDOR = '00000000-0000-4000-8000-0000000000e1';
const CONTACT = '00000000-0000-4000-8000-0000000000d1';
const KEY = 'key-1';

/** The same in-memory ZITADEL as portal-access.service.test.ts, trimmed to what a grant calls. */
class FakeZitadel {
  calls: string[] = [];
  orgs = new Map<string, string>(); // name -> id
  users: ZitadelUser[] = [];
  grants = new Map<string, string[]>(); // userId -> roles
  projectGrants: Array<{ orgId: string; roles: readonly string[] }> = [];
  policies: Array<{ orgId: string; patch: Readonly<OrgLoginPolicyPatch> }> = [];

  findOrganizationByName(name: string): Promise<string | null> {
    this.calls.push('findOrganizationByName');
    return Promise.resolve(this.orgs.get(name) ?? null);
  }
  createOrganization(name: string): Promise<string> {
    this.calls.push('createOrganization');
    const id = `z-org-${this.orgs.size + 1}`;
    this.orgs.set(name, id);
    return Promise.resolve(id);
  }
  ensureOrgLoginPolicy(
    orgId: string,
    patch: Readonly<OrgLoginPolicyPatch>,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    this.calls.push('ensureOrgLoginPolicy');
    this.policies.push({ orgId, patch });
    return Promise.resolve('created');
  }
  ensureProjectGrant(orgId: string, roles: readonly string[]): Promise<void> {
    this.calls.push('ensureProjectGrant');
    this.projectGrants.push({ orgId, roles: [...roles] });
    return Promise.resolve();
  }
  findHumanByUsername(orgId: string, username: string): Promise<ZitadelUser | null> {
    this.calls.push('findHumanByUsername');
    return Promise.resolve(
      this.users.find((u) => u.orgId === orgId && u.email === username) ?? null,
    );
  }
  createHuman(orgId: string, input: CreateHumanInput): Promise<string> {
    this.calls.push('createHuman');
    const id = `z-user-${this.users.length + 1}`;
    this.users.push({
      id,
      orgId,
      email: input.email,
      displayName: `${input.givenName} ${input.familyName}`,
      status: 'invited',
      createdAt: null,
    });
    return Promise.resolve(id);
  }
  setGrants(userId: string, _orgId: string, roles: readonly string[]): Promise<void> {
    this.calls.push('setGrants');
    this.grants.set(userId, [...roles]);
    return Promise.resolve();
  }
  sendInviteCode(): Promise<void> {
    this.calls.push('sendInviteCode');
    return Promise.resolve();
  }
}

class FakeVendorStore extends VendorPortalAccessStore {
  status: VendorStatus = 'approved';
  contact: VendorPortalTarget['contact'] = {
    id: CONTACT,
    fullName: 'Bikash Thapa',
    emailNorm: 'bikash@supply.test',
  };
  idpOrgs: Array<IdpOrgOwner & { zitadelOrgId: string }> = [];
  users = new Map<string, { userId: string; idpOrgId: string; roles: string[] }>();
  audit: string[] = [];
  answers = new Map<string, VendorPortalAccessDto>();

  loadVendorTarget(tenantId: string, vendorId: string): Promise<VendorPortalTarget | null> {
    if (tenantId !== TENANT || vendorId !== VENDOR) return Promise.resolve(null);
    const org = this.idpOrgs.find((o) => o.partyId === VENDOR && o.tenantId === TENANT);
    return Promise.resolve({
      vendor: {
        id: VENDOR,
        tenantId: TENANT,
        legalName: 'Himal Supplies',
        ownerUserId: null,
        status: this.status,
      } as VendorRow,
      contact: this.contact,
      idpOrg: org ? { idpOrgId: org.idpOrgId, zitadelOrgId: org.zitadelOrgId } : null,
    });
  }
  idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgOwner | null> {
    return Promise.resolve(this.idpOrgs.find((o) => o.zitadelOrgId === zitadelOrgId) ?? null);
  }
  isMirrored(zitadelUserId: string): Promise<boolean> {
    return Promise.resolve(this.users.has(zitadelUserId));
  }
  recordVendorRequested(): Promise<void> {
    this.audit.push('portal_access.requested');
    return Promise.resolve();
  }
  linkVendorOrg(
    _scope: TxScope,
    _actor: Actor,
    i: { partyId: string; zitadelOrgId: string },
  ): Promise<{ idpOrgId: string; created: boolean }> {
    const existing = this.idpOrgs.find((o) => o.partyId === i.partyId);
    if (existing) return Promise.resolve({ idpOrgId: existing.idpOrgId, created: false });
    const idpOrgId = `idp-${this.idpOrgs.length + 1}`;
    this.idpOrgs.push({
      idpOrgId,
      tenantId: TENANT,
      kind: 'vendor',
      partyId: i.partyId,
      zitadelOrgId: i.zitadelOrgId,
    });
    this.audit.push('portal_access.org_linked');
    return Promise.resolve({ idpOrgId, created: true });
  }
  finishVendor(
    _scope: TxScope,
    _actor: Actor,
    i: VendorFinishInput,
  ): Promise<{ status: number; response: VendorPortalAccessDto; replayed: boolean }> {
    const stored = this.answers.get(i.idempotencyKey);
    if (stored) return Promise.resolve({ status: 201, response: stored, replayed: true });
    const user = this.users.get(i.zitadelUserId) ?? {
      userId: `user-${this.users.size + 1}`,
      idpOrgId: i.idpOrgId,
      roles: [],
    };
    user.roles = ['vendor_user'];
    this.users.set(i.zitadelUserId, user);
    this.audit.push(...i.steps.map((s) => s.action), 'portal_access.granted');
    const response: VendorPortalAccessDto = {
      vendorId: i.vendorId,
      contactId: i.contactId,
      userId: user.userId,
      idpOrgId: i.idpOrgId,
      email: i.email,
      status: 'invited',
      inviteSent: i.inviteSent,
      capability: i.capability,
    };
    this.answers.set(i.idempotencyKey, response);
    return Promise.resolve({ status: 201, response, replayed: false });
  }
}

function principalOf(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'staff-1',
    zitadelUserId: 'z-staff-1',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: 'idp-staff',
    roles: ['procurement'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>([['vendor.write', 'all']]),
    ...overrides,
  };
}

let zitadel: FakeZitadel;
let store: FakeVendorStore;
let principal: Principal;
let service: VendorPortalAccessService;

beforeEach(() => {
  zitadel = new FakeZitadel();
  store = new FakeVendorStore();
  principal = principalOf();
  const caller: PortalAccessCaller = {
    current: () => ({
      scope: { tenantId: TENANT, organizationId: ENTITY },
      actor: { kind: 'user', id: principal.userId, correlationId: 'corr-1' },
      principal,
    }),
  };
  service = new VendorPortalAccessService(store, zitadel as unknown as ZitadelAdminClient, caller);
});

const grant = (key = KEY) => service.grant(VENDOR, { contactId: CONTACT }, key);

describe('vendor grant refusals (nothing reaches ZITADEL)', () => {
  it('refuses a vendor portal caller even when it holds vendor.write', async () => {
    principal = principalOf({ orgKind: 'vendor', partyId: VENDOR, idpOrgId: 'idp-v' });
    await expect(grant()).rejects.toBeInstanceOf(ForbiddenException);
    expect(zitadel.calls).toEqual([]);
  });

  it('refuses a staff caller without vendor.write', async () => {
    principal = principalOf({ grants: new Map([['customer.write', 'all']]) });
    await expect(grant()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 for a vendor outside the tenant', async () => {
    principal = principalOf({ tenantId: '00000000-0000-4000-8000-0000000000ff' });
    await expect(grant()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 for a contact that is not this vendor’s', async () => {
    store.contact = null;
    await expect(grant()).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each<VendorStatus>(['draft', 'under_review', 'suspended', 'blocked', 'archived'])(
    'answers 409 invalid_transition for a %s vendor',
    async (status) => {
      store.status = status;
      const error = await grant().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'invalid_transition',
      });
      expect(zitadel.calls).toEqual([]);
      expect(store.audit).toEqual([]);
    },
  );

  it('answers 400 when the contact has no email', async () => {
    store.contact = { id: CONTACT, fullName: 'Bikash', emailNorm: null };
    const error = await grant().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'contact_email_missing',
    });
    expect(zitadel.calls).toEqual([]);
  });
});

describe('vendor first grant', () => {
  it('creates a vendor org with the closed login policy and a vendor_user admin', async () => {
    const result = await grant();

    expect(zitadel.calls).toEqual([
      'findOrganizationByName',
      'createOrganization',
      'ensureOrgLoginPolicy',
      'ensureProjectGrant',
      'findHumanByUsername',
      'createHuman',
      'setGrants',
      'sendInviteCode',
    ]);
    expect(zitadel.orgs.get(portalOrgName('Himal Supplies', VENDOR))).toBe('z-org-1');
    // Registration closed (D11) and MFA forced, before any user exists in the org.
    expect(zitadel.policies).toEqual([{ orgId: 'z-org-1', patch: PORTAL_LOGIN_POLICY }]);
    expect(zitadel.projectGrants).toEqual([{ orgId: 'z-org-1', roles: ['vendor_user'] }]);
    expect(zitadel.grants.get('z-user-1')).toEqual(['vendor_user']);
    expect(store.idpOrgs).toEqual([
      {
        idpOrgId: 'idp-1',
        tenantId: TENANT,
        kind: 'vendor',
        partyId: VENDOR,
        zitadelOrgId: 'z-org-1',
      },
    ]);
    expect(store.users.get('z-user-1')?.roles).toEqual(['vendor_user']);
    expect(result).toEqual({
      status: 201,
      response: {
        vendorId: VENDOR,
        contactId: CONTACT,
        userId: 'user-1',
        idpOrgId: 'idp-1',
        email: 'bikash@supply.test',
        status: 'invited',
        inviteSent: true,
        capability: 'full',
      },
    });
    expect(store.audit).toEqual([
      'portal_access.requested',
      'portal_access.org_linked',
      'portal_access.zitadel_org_created',
      'portal_access.login_policy_pinned',
      'portal_access.project_granted',
      'portal_access.zitadel_user_created',
      'portal_access.role_granted',
      'portal_access.invite_sent',
      'portal_access.granted',
    ]);
  });

  it('grants a pending_kyc vendor with onboarding-only capability', async () => {
    store.status = 'pending_kyc';
    const result = await grant();
    expect(result.response.capability).toBe('onboarding_only');
    expect(zitadel.grants.get('z-user-1')).toEqual(['vendor_user']);
  });

  it('refuses a ZITADEL org that idp_orgs already maps to another party (409 idp_org_taken)', async () => {
    zitadel.orgs.set(portalOrgName('Himal Supplies', VENDOR), 'z-org-other');
    store.idpOrgs.push({
      idpOrgId: 'idp-other',
      tenantId: TENANT,
      kind: 'customer',
      partyId: '00000000-0000-4000-8000-0000000000c9',
      zitadelOrgId: 'z-org-other',
    });
    const error = await grant().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'idp_org_taken' });
    expect(zitadel.calls).not.toContain('createHuman');
  });
});

describe('vendor retries', () => {
  it('a second grant with a new key reuses the org and the user and sends no second invite', async () => {
    await grant('key-1');
    zitadel.calls = [];
    const again = await grant('key-2');
    expect(zitadel.calls).toEqual([
      'ensureOrgLoginPolicy',
      'ensureProjectGrant',
      'findHumanByUsername',
      'setGrants',
    ]);
    expect(zitadel.orgs.size).toBe(1);
    expect(zitadel.users).toHaveLength(1);
    expect(again.response.inviteSent).toBe(false);
  });
});
