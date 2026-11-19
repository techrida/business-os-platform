// Which images belong to the tenant rather than one entity (U12, D33). People (users) and parties (customers,
// vendors) are tenant-level records (no organization_id, ADR 0027 D17), so their picture pointers are tenant-wide,
// while the image document still carries the entity it was uploaded in. Those images are served, set as current and
// removed from any entity of the tenant; the tenant filter always stays. `entity_logo` is the entity's own and stays
// tenant AND entity scoped.
import type { ImageOwnerType } from '@bos/contracts';

const TENANT_WIDE: readonly ImageOwnerType[] = ['user_avatar', 'customer_logo', 'vendor_logo'];

/** Image owner types whose documents are visible to, and replaceable from, every entity of their tenant. */
export const TENANT_WIDE_IMAGE_OWNERS: ReadonlySet<string> = new Set<string>(TENANT_WIDE);

/** True when documents of `ownerType` are tenant-wide images (see TENANT_WIDE_IMAGE_OWNERS). */
export function isTenantWideImageOwner(ownerType: string): boolean {
  return TENANT_WIDE_IMAGE_OWNERS.has(ownerType);
}
