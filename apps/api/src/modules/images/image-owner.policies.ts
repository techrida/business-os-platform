// The documents owner policies of images (U12, D33): the company logo, a user's profile picture, a customer's and a
// vendor's logo. Every image is a document of one of these owner types, so DocumentsService applies the type and size
// rules (PNG, JPEG, WebP up to 512 KiB: `allowedMime`, `maxBytes`), the type check and the virus scan, and asks these
// policies who may upload. Serves the NFRs:
// - "deny by default": the record must exist in the caller's scope (null answers 404), only the company logo takes
//   a file from a background job (the legacy-logo migrator), and no portal caller uploads here;
// - "who may change it is who may edit the record": the company logo needs `admin.settings.write`, a customer or
//   vendor logo the grant that edits the customer or vendor (`customer.write`, `vendor.write`);
// - a profile picture needs `profile.avatar.write` against a ref whose owner is the pictured user, so scope `own`
//   (every staff role) is "my own picture" and scope `all` (founder, user managers) is "anyone's picture".
// ImagesModule registers them through ImageOwnerRegistrar (images.registrar.ts).
import {
  IMAGE_MAX_BYTES,
  IMAGE_MIME,
  type EntityLogoOwnerType,
  type ImageOwnerType,
  type Permission,
} from '@bos/contracts';
import { customers, users, vendors } from '@bos/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { ResourceRef } from '../../platform/authz/can';
import type { Db } from '../../platform/db/db.module';
import type { Actor, TxScope } from '../../platform/db/tx';
import type { DocumentOwnerPolicy } from '../../platform/documents/documents.ports';

/** The grant that uploads each kind of image (staff path). */
export const IMAGE_UPLOAD_PERMISSIONS = {
  entity_logo: 'admin.settings.write',
  entity_logo_on_dark: 'admin.settings.write',
  entity_logo_on_light: 'admin.settings.write',
  user_avatar: 'profile.avatar.write',
  customer_logo: 'customer.write',
  vendor_logo: 'vendor.write',
} as const satisfies Record<ImageOwnerType, Permission>;

/** A record an image belongs to, as far as authz needs it: who owns it. */
export interface ImageOwnerRow {
  ownerUserId: string | null;
}

/** Finds the owner record in the scope's tenant; undefined when it does not exist. */
export type ImageOwnerLoader = (
  scope: TxScope,
  ownerId: string,
) => Promise<ImageOwnerRow | undefined>;

export interface ImageOwnerLoaders {
  /** A user of the tenant. `ownerUserId` is the user's own id: a person owns their picture. */
  user: ImageOwnerLoader;
  customer: ImageOwnerLoader;
  vendor: ImageOwnerLoader;
}

/** What every image owner shares: the image allow-list and size, and no condition on attaching. */
const IMAGE_LIMITS = {
  allowedMime: IMAGE_MIME,
  maxBytes: IMAGE_MAX_BYTES,
  canAttach: () => Promise.resolve(true),
} satisfies Pick<DocumentOwnerPolicy, 'allowedMime' | 'maxBytes' | 'canAttach'>;

const Guid = z.guid();
/** Not a uuid means no such record; the database is never asked (a malformed uuid would be a 500 there). */
const isGuid = (value: string): boolean => Guid.safeParse(value).success;

/**
 * The logo of the acting entity, in any of its three slots (the primary and the optional ones for dark and for light
 * backgrounds; each slot is its own owner type): owner id = the entity (organization) id, and only the scope's own entity. Changing
 * it is a settings change (`admin.settings.write`). The system actor may add it too: the boot-time migrator moves
 * each stored data-URL logo into the documents pipeline (still type-checked and scanned).
 */
export function entityLogoOwnerPolicy(
  ownerType: EntityLogoOwnerType = 'entity_logo',
): DocumentOwnerPolicy {
  const isOwnEntity = (scope: TxScope, ownerId: string) =>
    ownerId.length > 0 && ownerId === scope.organizationId;
  return {
    ownerType,
    uploadPermission: IMAGE_UPLOAD_PERMISSIONS[ownerType],
    ...IMAGE_LIMITS,
    resource: (scope, ownerId) =>
      Promise.resolve(
        isOwnEntity(scope, ownerId)
          ? { tenantId: scope.tenantId, organizationId: scope.organizationId }
          : null,
      ),
    allowsSystemActor: (scope, ownerId, actor: Pick<Actor, 'kind' | 'id'>) =>
      Promise.resolve(actor.kind === 'system' && isOwnEntity(scope, ownerId)),
  };
}

/**
 * A user's profile picture: owner id = `app.users.id` of a user of the tenant (people are tenant-wide). The ref's
 * `ownerUserId` is that user, so with `profile.avatar.write` scope `own` (every staff role by default, finance and
 * accountant included, who hold no `documents.upload`) lets a user set only their own picture, and scope `all`
 * (founder and any role holding `admin.users.invite`, migration 0053) anyone's. DocumentOwnerPolicy has one upload
 * grant and `can()` refuses on the grant before it reads the ref, so the admin case is a scope, not a second grant.
 */
export function userAvatarOwnerPolicy(loadUser: ImageOwnerLoader): DocumentOwnerPolicy {
  return {
    ownerType: 'user_avatar',
    uploadPermission: IMAGE_UPLOAD_PERMISSIONS.user_avatar,
    ...IMAGE_LIMITS,
    resource: async (scope, ownerId) => {
      if (!isGuid(ownerId)) return null;
      const row = await loadUser(scope, ownerId);
      if (row === undefined) return null;
      return {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        ownerUserId: row.ownerUserId,
      };
    },
  };
}

/** A customer's logo: the customer must exist in the tenant; the ref is the one the customer routes check. */
export function customerLogoOwnerPolicy(loadCustomer: ImageOwnerLoader): DocumentOwnerPolicy {
  return {
    ownerType: 'customer_logo',
    uploadPermission: IMAGE_UPLOAD_PERMISSIONS.customer_logo,
    ...IMAGE_LIMITS,
    resource: async (scope, ownerId): Promise<ResourceRef | null> => {
      if (!isGuid(ownerId)) return null;
      const row = await loadCustomer(scope, ownerId);
      if (row === undefined) return null;
      return {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        ownerUserId: row.ownerUserId,
        customerPartyId: ownerId,
      };
    },
  };
}

/** A vendor's logo: the vendor must exist in the tenant; the ref is the one vendorRef() gives the vendor routes. */
export function vendorLogoOwnerPolicy(loadVendor: ImageOwnerLoader): DocumentOwnerPolicy {
  return {
    ownerType: 'vendor_logo',
    uploadPermission: IMAGE_UPLOAD_PERMISSIONS.vendor_logo,
    ...IMAGE_LIMITS,
    resource: async (scope, ownerId): Promise<ResourceRef | null> => {
      if (!isGuid(ownerId)) return null;
      const row = await loadVendor(scope, ownerId);
      if (row === undefined) return null;
      return {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        ownerUserId: row.ownerUserId,
        vendorPartyId: ownerId,
      };
    },
  };
}

/** The policies, in IMAGE_OWNER_TYPES order. */
export function imageOwnerPolicies(loaders: ImageOwnerLoaders): DocumentOwnerPolicy[] {
  return [
    entityLogoOwnerPolicy('entity_logo'),
    entityLogoOwnerPolicy('entity_logo_on_dark'),
    entityLogoOwnerPolicy('entity_logo_on_light'),
    userAvatarOwnerPolicy(loaders.user),
    customerLogoOwnerPolicy(loaders.customer),
    vendorLogoOwnerPolicy(loaders.vendor),
  ];
}

/** The database loaders: each looks the record up by tenant and id (users, customers and vendors are tenant-wide). */
export function drizzleImageOwnerLoaders(db: Db): ImageOwnerLoaders {
  return {
    user: async (scope, userId) => {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, userId)));
      return row === undefined ? undefined : { ownerUserId: row.id };
    },
    customer: async (scope, customerId) => {
      const [row] = await db
        .select({ ownerUserId: customers.ownerUserId })
        .from(customers)
        .where(and(eq(customers.tenantId, scope.tenantId), eq(customers.id, customerId)));
      return row;
    },
    vendor: async (scope, vendorId) => {
      const [row] = await db
        .select({ ownerUserId: vendors.ownerUserId })
        .from(vendors)
        .where(and(eq(vendors.tenantId, scope.tenantId), eq(vendors.id, vendorId)));
      return row;
    },
  };
}
