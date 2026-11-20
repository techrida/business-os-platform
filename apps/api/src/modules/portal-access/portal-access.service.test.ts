// Unit tests of PortalAccessService with a fake store and a fake ZITADEL client: the refusals (staff only, KYB,
// email), the order of the ZITADEL calls on a first grant, and that a retry reuses the org and the user instead
// of creating duplicates. The SQL side is covered by portal-access.integration.test.ts.
import type { Permission, Scope } from '@bos/contracts';
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
  ZitadelHttpError,
  type CreateHumanInput,
  type OrgLoginPolicyPatch,
  type ZitadelAdminClient,
  type ZitadelUser,
} from '../../platform/users/zitadel-admin.client';
import type { PortalAccessCaller } from './portal-access.caller';
import { PortalAccessService, portalOrgName } from './portal-access.service';
import {
  PortalAccessStore,
  type CustomerRow,
  type FinishInput,
  type IdpOrgOwner,
  type PortalAccessDto,
  type PortalTarget,
} from './portal-access.types';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '00000000-0000-4000-8000-000000000002';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c1';
const CONTACT = '00000000-0000-4000-8000-0000000000d1';
const KEY = 'key-1';

class FakeZitadel {
  calls: string[] = [];
  orgs = new Map<string, string>(); // name -> id
  users: ZitadelUser[] = [];
  grants = new Map<string, string[]>(); // userId -> roles
  /** Simulates a concurrent first call: the org appears between our lookup and our create. */
  raceOnCreateOrg = false;

  findOrganizationByName(name: string): Promise<string | null> {
    this.calls.push('findOrganizationByName');
    return Promise.resolve(this.orgs.get(name) ?? null);
  }
  createOrganization(name: string): Promise<string> {
    this.calls.push('createOrganization');
    if (this.raceOnCreateOrg) {
      this.orgs.set(name, 'z-org-raced');
      return Promise.reject(new ZitadelHttpError('/AddOrganization', 409, 'already_exists'));
    }
    const id = `z-org-${this.orgs.size + 1}`;
    this.orgs.set(name, id);
    return Promise.resolve(id);
  }
  /** Each org whose login policy was pinned, with the settings asked for. */
  policies: Array<{ orgId: string; patch: Readonly<OrgLoginPolicyPatch> }> = [];
  ensureOrgLoginPolicy(
    orgId: string,
    patch: Readonly<OrgLoginPolicyPatch>,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    this.calls.push('ensureOrgLoginPolicy');
    this.policies.push({ orgId, patch });
    return Promise.resolve('created');
  }
  ensureProjectGrant(): Promise<void> {
    this.calls.push('ensureProjectGrant');
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

class FakeStore extends PortalAccessStore {
  kybStatus: string | null = 'approved';
  /** The customer's account owner: the default caller (staff-1), so a first grant passes F1-Q31. */
  ownerUserId: string | null = 'staff-1';
  contact: PortalTarget['contact'] = {
    id: CONTACT,
    fullName: 'Ana Maria Bista',
    emailNorm: 'ana@acme.test',
  };
  idpOrgs: Array<IdpOrgOwner & { zitadelOrgId: string }> = [];
  users = new Map<string, { userId: string; idpOrgId: string; roles: string[] }>();
  audit: string[] = [];
  answers = new Map<string, PortalAccessDto>();

  loadTarget(tenantId: string, customerId: string): Promise<PortalTarget | null> {
    if (tenantId !== TENANT || customerId !== CUSTOMER) return Promise.resolve(null);
    const org = this.idpOrgs.find((o) => o.partyId === CUSTOMER && o.tenantId === TENANT);
    return Promise.resolve({
      customer: {
        id: CUSTOMER,
        tenantId: TENANT,
        legalName: 'Acme Traders',
        ownerUserId: this.ownerUserId,
        mergedIntoId: null,
      } as CustomerRow,
      contact: this.contact,
      kybStatus: this.kybStatus,
      idpOrg: org ? { idpOrgId: org.idpOrgId, zitadelOrgId: org.zitadelOrgId } : null,
      hasPortalUser:
        org !== undefined && [...this.users.values()].some((u) => u.idpOrgId === org.idpOrgId),
    });
  }
  idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgOwner | null> {
    return Promise.resolve(this.idpOrgs.find((o) => o.zitadelOrgId === zitadelOrgId) ?? null);
  }
  isMirrored(zitadelUserId: string): Promise<boolean> {
    return Promise.resolve(this.users.has(zitadelUserId));
  }
  recordRequested(): Promise<void> {
    this.audit.push('portal_access.requested');
    return Promise.resolve();
  }
  linkOrg(
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
      kind: 'customer',
      partyId: i.partyId,
      zitadelOrgId: i.zitadelOrgId,
    });
    this.audit.push('portal_access.org_linked');
    return Promise.resolve({ idpOrgId, created: true });
  }
  finish(
    _scope: TxScope,
    _actor: Actor,
    i: FinishInput,
  ): Promise<{ status: number; response: PortalAccessDto; replayed: boolean }> {
    const stored = this.answers.get(i.idempotencyKey);
    if (stored) return Promise.resolve({ status: 201, response: stored, replayed: true });
    const user = this.users.get(i.zitadelUserId) ?? {
      userId: `user-${this.users.size + 1}`,
      idpOrgId: i.idpOrgId,
      roles: [],
    };
    user.roles = ['customer_user'];
    this.users.set(i.zitadelUserId, user);
    this.audit.push(...i.steps.map((s) => s.action), 'portal_access.granted');
    const response: PortalAccessDto = {
      customerId: i.customerId,
      contactId: i.contactId,
      userId: user.userId,
      idpOrgId: i.idpOrgId,
      email: i.email,
      status: 'invited',
      inviteSent: i.inviteSent,
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
    roles: ['founder'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>([['customer.write', 'all']]),
    ...overrides,
  };
}

let zitadel: FakeZitadel;
let store: FakeStore;
let principal: Principal;
let service: PortalAccessService;

beforeEach(() => {
  zitadel = new FakeZitadel();
  store = new FakeStore();
  principal = principalOf();
  const caller: PortalAccessCaller = {
    current: () => ({
      scope: { tenantId: TENANT, organizationId: ENTITY },
      actor: { kind: 'user', id: principal.userId, correlationId: 'corr-1' },
      principal,
    }),
  };
  service = new PortalAccessService(store, zitadel as unknown as ZitadelAdminClient, caller);
});

const grant = (key = KEY) => service.grant(CUSTOMER, { contactId: CONTACT }, key);

describe('refusals (nothing reaches ZITADEL)', () => {
  it('refuses a portal caller even when it holds customer.write', async () => {
    principal = principalOf({ orgKind: 'customer', partyId: CUSTOMER, idpOrgId: 'idp-c' });
    await expect(grant()).rejects.toBeInstanceOf(ForbiddenException);
    expect(zitadel.calls).toEqual([]);
  });

  it('refuses a staff caller without customer.write', async () => {
    principal = principalOf({ grants: new Map() });
    await expect(grant()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 for a customer outside the tenant', async () => {
    principal = principalOf({ tenantId: '00000000-0000-4000-8000-0000000000ff' });
    await expect(grant()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 for a contact that is not this customer’s', async () => {
    store.contact = null;
    await expect(grant()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('names the rule when the contact is not one of this customer’s', async () => {
    store.contact = null;
    const error = await grant().catch((e: unknown) => e);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      code: 'not_found',
      message: expect.stringContaining("must be one of the customer's existing contacts"),
    });
    expect(zitadel.calls).toEqual([]);
    expect(store.audit).toEqual([]);
  });

  it.each([null, 'draft', 'submitted', 'rejected', 'expired'])(
    'answers 409 kyb_not_verified when the KYB case is %s',
    async (status) => {
      store.kybStatus = status;
      const error = await grant().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'kyb_not_verified',
      });
      expect(zitadel.calls).toEqual([]);
    },
  );

  it('answers 400 when the contact has no email', async () => {
    store.contact = { id: CONTACT, fullName: 'Ana', emailNorm: null };
    const error = await grant().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'contact_email_missing',
    });
    expect(zitadel.calls).toEqual([]);
  });
});

describe('first portal admin (F1-Q31): the account owner invites it', () => {
  it('refuses 409 first_admin_owner_only when a staff caller with customer.write is not the owner', async () => {
    store.ownerUserId = 'staff-other';
    const error = await grant().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'first_admin_owner_only',
    });
    expect(zitadel.calls).toEqual([]);
    expect(store.audit).toEqual([]);
  });

  it('refuses 409 account_owner_missing when the customer has no account owner', async () => {
    store.ownerUserId = null;
    const error = await grant().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'account_owner_missing',
    });
    expect(zitadel.calls).toEqual([]);
  });

  it('lets another customer.write holder grant once the customer has a portal user', async () => {
    await grant('key-owner');
    store.ownerUserId = 'staff-other';
    const again = await grant('key-other');
    expect(again.status).toBe(201);
  });

  it('still counts as first while the org exists but nobody was mirrored (a grant that died midway)', async () => {
    store.idpOrgs.push({
      idpOrgId: 'idp-1',
      tenantId: TENANT,
      kind: 'customer',
      partyId: CUSTOMER,
      zitadelOrgId: 'z-org-1',
    });
    store.ownerUserId = 'staff-other';
    await expect(grant()).rejects.toMatchObject({
      response: { code: 'first_admin_owner_only' },
    });
  });
});

describe('first grant', () => {
  it('creates the org, the user, the invite and the role grant, then writes idp_orgs and the user', async () => {
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
    expect(zitadel.orgs.get(portalOrgName('Acme Traders', CUSTOMER))).toBe('z-org-1');
    // A new org inherits the instance login policy, which may allow self-registration: it is pinned before any
    // user exists in it, with registration off and MFA forced (D23 = C).
    expect(zitadel.policies).toEqual([{ orgId: 'z-org-1', patch: PORTAL_LOGIN_POLICY }]);
    expect(PORTAL_LOGIN_POLICY).toMatchObject({ allowRegister: false, forceMfa: true });
    expect(zitadel.users[0]).toMatchObject({
      email: 'ana@acme.test',
      displayName: 'Ana Maria Bista',
      orgId: 'z-org-1',
    });
    expect(zitadel.grants.get('z-user-1')).toEqual(['customer_user']);
    expect(store.idpOrgs).toEqual([
      {
        idpOrgId: 'idp-1',
        tenantId: TENANT,
        kind: 'customer',
        partyId: CUSTOMER,
        zitadelOrgId: 'z-org-1',
      },
    ]);
    expect(store.users.get('z-user-1')).toEqual({
      userId: 'user-1',
      idpOrgId: 'idp-1',
      roles: ['customer_user'],
    });
    expect(result.status).toBe(201);
    expect(result.response).toMatchObject({
      userId: 'user-1',
      idpOrgId: 'idp-1',
      inviteSent: true,
      status: 'invited',
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

  it('names the org after the customer and its party id, so equal legal names never collide', () => {
    expect(portalOrgName('Acme Traders', CUSTOMER)).toBe(`Acme Traders [${CUSTOMER}]`);
  });

  it('reuses the org a concurrent first call created (409 on create)', async () => {
    zitadel.raceOnCreateOrg = true;
    await grant();
    expect(store.idpOrgs[0]?.zitadelOrgId).toBe('z-org-raced');
  });

  it('refuses a ZITADEL org that idp_orgs already maps to another party', async () => {
    zitadel.orgs.set(portalOrgName('Acme Traders', CUSTOMER), 'z-org-taken');
    store.idpOrgs.push({
      idpOrgId: 'idp-x',
      tenantId: TENANT,
      kind: 'customer',
      partyId: 'other',
      zitadelOrgId: 'z-org-taken',
    });
    const error = await grant().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(zitadel.calls).not.toContain('createHuman');
    // Another party's org is never changed, not even its login policy.
    expect(zitadel.calls).not.toContain('ensureOrgLoginPolicy');
  });
});

describe('retries', () => {
  it('a second grant with a new key reuses the org and the user and sends no second invite', async () => {
    await grant('key-1');
    zitadel.calls = [];
    const again = await grant('key-2');

    // The linked org's login policy is pinned again, so orgs made before the policy call get fixed too.
    expect(zitadel.calls).toEqual([
      'ensureOrgLoginPolicy',
      'ensureProjectGrant',
      'findHumanByUsername',
      'setGrants',
    ]);
    expect(zitadel.policies.at(-1)).toEqual({ orgId: 'z-org-1', patch: PORTAL_LOGIN_POLICY });
    expect(zitadel.orgs.size).toBe(1);
    expect(zitadel.users).toHaveLength(1);
    expect(store.idpOrgs).toHaveLength(1);
    expect(store.users.size).toBe(1);
    expect(again.response).toMatchObject({ userId: 'user-1', inviteSent: false });
  });

  it('after a crash between ZITADEL and the database, the retry finds the org and user and re-sends the invite', async () => {
    // A first attempt created both in ZITADEL, then died before any row was written.
    zitadel.orgs.set(portalOrgName('Acme Traders', CUSTOMER), 'z-org-1');
    await zitadel.createHuman('z-org-1', {
      email: 'ana@acme.test',
      givenName: 'Ana',
      familyName: 'Bista',
    });
    zitadel.calls = [];

    const result = await grant();

    expect(zitadel.calls).toEqual([
      'findOrganizationByName',
      'ensureOrgLoginPolicy',
      'ensureProjectGrant',
      'findHumanByUsername',
      'setGrants',
      'sendInviteCode',
    ]);
    expect(zitadel.users).toHaveLength(1);
    expect(store.idpOrgs[0]?.zitadelOrgId).toBe('z-org-1');
    expect(result.response.inviteSent).toBe(true);
    expect(store.audit).toContain('portal_access.zitadel_org_reused');
    expect(store.audit).toContain('portal_access.zitadel_user_reused');
  });

  it('does not invite a reused user who already accepted', async () => {
    zitadel.orgs.set(portalOrgName('Acme Traders', CUSTOMER), 'z-org-1');
    zitadel.users.push({
      id: 'z-u',
      orgId: 'z-org-1',
      email: 'ana@acme.test',
      displayName: 'Ana',
      status: 'active',
      createdAt: null,
    });
    const result = await grant();
    expect(zitadel.calls).not.toContain('sendInviteCode');
    expect(result.response.inviteSent).toBe(false);
  });

  it('creates no user when the login policy cannot be pinned', async () => {
    zitadel.ensureOrgLoginPolicy = () =>
      Promise.reject(new ZitadelHttpError('/management/v1/policies/login', 403, 'denied'));
    await expect(grant()).rejects.toBeInstanceOf(ZitadelHttpError);
    expect(zitadel.calls).not.toContain('ensureProjectGrant');
    expect(zitadel.calls).not.toContain('createHuman');
  });

  it('falls back to the lookup when createHuman answers 409', async () => {
    zitadel.createHuman = (orgId: string) => {
      zitadel.users.push({
        id: 'z-raced',
        orgId,
        email: 'ana@acme.test',
        displayName: 'Ana',
        status: 'invited',
        createdAt: null,
      });
      return Promise.reject(new ZitadelHttpError('/CreateUser', 409, 'already_exists'));
    };
    const result = await grant();
    expect(store.users.has('z-raced')).toBe(true);
    expect(result.status).toBe(201);
  });
});
