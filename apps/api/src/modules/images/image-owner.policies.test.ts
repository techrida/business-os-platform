// Unit test of the image owner policies (U12, D33): who may upload each kind of image (the real can() with the
// default role grants against each policy's ref and upload grant), a missing owner is null (404), only the company
// logo takes a file from the system actor, and every image owner narrows the types and size. Fake loaders: the
// database is never reached.
// Run: apps/api/node_modules/.bin/vitest run src/modules/images/image-owner.policies.test.ts (from apps/api)
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  IMAGE_MAX_BYTES,
  IMAGE_MIME,
  IMAGE_OWNER_TYPES,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { can, type DenyReason, type Principal, type ResourceRef } from '../../platform/authz/can';
import type { DocumentOwnerPolicy } from '../../platform/documents/documents.ports';
import {
  customerLogoOwnerPolicy,
  entityLogoOwnerPolicy,
  type ImageOwnerLoader,
  type ImageOwnerRow,
  imageOwnerPolicies,
  userAvatarOwnerPolicy,
  vendorLogoOwnerPolicy,
} from './image-owner.policies';

const TENANT = randomUUID();
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const scope = { tenantId: TENANT, organizationId: ORG };

const SELF = randomUUID();
const OTHER_USER = randomUUID();
const CUSTOMER = randomUUID();
const VENDOR = randomUUID();

/** A loader over a fixed map, which records the ids it was asked for. */
function fakeLoader(rows: Record<string, ImageOwnerRow>) {
  const asked: string[] = [];
  const load: ImageOwnerLoader = (s, id) => {
    asked.push(id);
    return Promise.resolve(s.tenantId === TENANT ? rows[id] : undefined);
  };
  return { load, asked };
}

const userLoader = fakeLoader({
  [SELF]: { ownerUserId: SELF },
  [OTHER_USER]: { ownerUserId: OTHER_USER },
});
const customerLoader = fakeLoader({ [CUSTOMER]: { ownerUserId: OTHER_USER } });
const vendorLoader = fakeLoader({ [VENDOR]: { ownerUserId: OTHER_USER } });

const entityLogo = entityLogoOwnerPolicy();
const userAvatar = userAvatarOwnerPolicy(userLoader.load);
const customerLogo = customerLogoOwnerPolicy(customerLoader.load);
const vendorLogo = vendorLogoOwnerPolicy(vendorLoader.load);
const all = imageOwnerPolicies({
  user: userLoader.load,
  customer: customerLoader.load,
  vendor: vendorLoader.load,
});

/** An active staff principal of the tenant and entity with the default grants of `roles`. */
function staff(userId: string, ...roles: RoleKey[]): Principal {
  const grants = new Map<Permission, Scope>();
  for (const role of roles) {
    for (const [permission, roleScope] of Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) {
      // Every role here grants a permission at one scope at most; the widest-scope merge is not under test.
      grants.set(permission as Permission, roleScope);
    }
  }
  return {
    userId,
    zitadelUserId: `zitadel-${userId}`,
    tenantId: TENANT,
    organizationId: ORG,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: randomUUID(),
    roles,
    departmentId: null,
    status: 'active',
    grants,
  };
}

/** What DocumentsService decides for a staff upload: 404 for no ref, else can() on the policy's upload grant. */
async function mayUpload(
  p: Principal,
  policy: DocumentOwnerPolicy,
  ownerId: string,
): Promise<'allowed' | 'not_found' | DenyReason> {
  const ref: ResourceRef | null = await policy.resource(scope, ownerId);
  if (ref === null) return 'not_found';
  const decision = can(p, policy.uploadPermission ?? 'documents.upload', ref);
  return decision.allowed ? 'allowed' : decision.reason;
}

describe('image owner policies', () => {
  it('cover the four image owner types, in order', () => {
    expect(all.map((p) => p.ownerType)).toEqual([...IMAGE_OWNER_TYPES]);
  });

  it('narrow every upload to PNG, JPEG and WebP up to IMAGE_MAX_BYTES and always take attachments', async () => {
    for (const policy of all) {
      expect(policy.allowedMime).toEqual(IMAGE_MIME);
      expect(policy.allowedMime).not.toContain('image/svg+xml');
      expect(policy.maxBytes).toBe(IMAGE_MAX_BYTES);
      expect(await policy.canAttach?.(scope, randomUUID())).toBe(true);
    }
  });

  it('take no portal uploads', () => {
    for (const policy of all) expect(policy.allowsCounterparty).toBeUndefined();
  });

  it('let only the company logo take a file from the system actor', async () => {
    const system = { kind: 'system' as const, id: 'system:legacy-logo' };
    expect(await entityLogo.allowsSystemActor?.(scope, ORG, system)).toBe(true);
    // Only for the scope's own entity, and only a system actor.
    expect(await entityLogo.allowsSystemActor?.(scope, OTHER_ORG, system)).toBe(false);
    expect(await entityLogo.allowsSystemActor?.(scope, ORG, { kind: 'user', id: SELF })).toBe(
      false,
    );
    for (const policy of [userAvatar, customerLogo, vendorLogo]) {
      expect(policy.allowsSystemActor).toBeUndefined();
    }
  });
});

describe('entity_logo', () => {
  it('is uploaded with admin.settings.write', () => {
    expect(entityLogo.uploadPermission).toBe('admin.settings.write');
  });

  it('exists only as the scope entity: another entity, an empty or a malformed id is null', async () => {
    expect(await entityLogo.resource(scope, ORG)).toEqual({
      tenantId: TENANT,
      organizationId: ORG,
    });
    expect(await entityLogo.resource(scope, OTHER_ORG)).toBeNull();
    expect(await entityLogo.resource(scope, '')).toBeNull();
    expect(await entityLogo.resource(scope, 'not-a-uuid')).toBeNull();
  });

  it('may be changed by the founder and not by a sales user', async () => {
    expect(await mayUpload(staff(SELF, 'founder'), entityLogo, ORG)).toBe('allowed');
    expect(await mayUpload(staff(SELF, 'sales'), entityLogo, ORG)).toBe('no_permission');
  });
});

describe('user_avatar', () => {
  it('uses the documents default grant against a ref owned by the pictured user', async () => {
    expect(userAvatar.uploadPermission).toBe('documents.upload');
    expect(await userAvatar.resource(scope, SELF)).toEqual({
      tenantId: TENANT,
      organizationId: ORG,
      ownerUserId: SELF,
    });
  });

  it('lets a user with documents.upload at own set only their own picture', async () => {
    expect(await mayUpload(staff(SELF, 'sales'), userAvatar, SELF)).toBe('allowed');
    expect(await mayUpload(staff(SELF, 'sales'), userAvatar, OTHER_USER)).toBe('out_of_scope');
  });

  it('lets a holder of documents.upload at all (the founder) set anyone in the tenant', async () => {
    expect(await mayUpload(staff(SELF, 'founder'), userAvatar, OTHER_USER)).toBe('allowed');
  });

  it('is null (404) for a user not in the tenant or a malformed id, and asks no database for the latter', async () => {
    expect(await userAvatar.resource(scope, randomUUID())).toBeNull();
    expect(
      await userAvatar.resource({ tenantId: randomUUID(), organizationId: ORG }, SELF),
    ).toBeNull();
    const before = userLoader.asked.length;
    expect(await userAvatar.resource(scope, 'not-a-uuid')).toBeNull();
    expect(userLoader.asked.length).toBe(before);
  });
});

describe('customer_logo', () => {
  it('is uploaded with customer.write against the customer ref', async () => {
    expect(customerLogo.uploadPermission).toBe('customer.write');
    expect(await customerLogo.resource(scope, CUSTOMER)).toEqual({
      tenantId: TENANT,
      organizationId: ORG,
      ownerUserId: OTHER_USER,
      customerPartyId: CUSTOMER,
    });
  });

  it('may be changed by sales (customer.write at all) and not by procurement', async () => {
    expect(await mayUpload(staff(SELF, 'sales'), customerLogo, CUSTOMER)).toBe('allowed');
    expect(await mayUpload(staff(SELF, 'procurement'), customerLogo, CUSTOMER)).toBe(
      'no_permission',
    );
  });

  it('is null (404) when the customer does not exist', async () => {
    expect(await customerLogo.resource(scope, randomUUID())).toBeNull();
    expect(await customerLogo.resource(scope, 'not-a-uuid')).toBeNull();
  });
});

describe('vendor_logo', () => {
  it('is uploaded with vendor.write against the vendor ref', async () => {
    expect(vendorLogo.uploadPermission).toBe('vendor.write');
    expect(await vendorLogo.resource(scope, VENDOR)).toEqual({
      tenantId: TENANT,
      organizationId: ORG,
      ownerUserId: OTHER_USER,
      vendorPartyId: VENDOR,
    });
  });

  it('may be changed by procurement (vendor.write at all) and not by sales', async () => {
    expect(await mayUpload(staff(SELF, 'procurement'), vendorLogo, VENDOR)).toBe('allowed');
    expect(await mayUpload(staff(SELF, 'sales'), vendorLogo, VENDOR)).toBe('no_permission');
  });

  it('is null (404) when the vendor does not exist', async () => {
    expect(await vendorLogo.resource(scope, randomUUID())).toBeNull();
    expect(await vendorLogo.resource(scope, 'not-a-uuid')).toBeNull();
  });
});
