import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../../../platform/db/db.module';
import {
  PO_RENDER_JOB_PREFIX,
  PO_VERSION_OWNER_TYPE,
  PurchaseOrderVersionOwnerPolicy,
  type PoVersionHeadLoader,
} from './purchase-order-version-owner.policy';

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };
const head = { tenantId: 'tenant-1', organizationId: 'org-1', vendorId: 'vendor-1' };
const renderJob = { kind: 'system' as const, id: `system:${PO_RENDER_JOB_PREFIX}` };

const policyWith = (found: typeof head | undefined) => {
  const load = vi.fn<PoVersionHeadLoader>().mockResolvedValue(found);
  return { policy: new PurchaseOrderVersionOwnerPolicy(load), load };
};

describe('PurchaseOrderVersionOwnerPolicy', () => {
  it('owns purchase_order_version', () => {
    expect(policyWith(head).policy.ownerType).toBe(PO_VERSION_OWNER_TYPE);
    expect(PO_VERSION_OWNER_TYPE).toBe('purchase_order_version');
  });

  it('allows the render job for a version of the acting entity', async () => {
    const { policy, load } = policyWith(head);
    const tx = { marker: 'tx' } as unknown as DbTransaction;
    await expect(policy.allowsSystemActor(scope, 'v-1', renderJob, tx)).resolves.toBe(true);
    expect(load).toHaveBeenCalledWith(scope, 'v-1', tx);
  });

  it('refuses the render job for a version that is not in the entity', async () => {
    const { policy } = policyWith(undefined);
    await expect(policy.allowsSystemActor(scope, 'v-1', renderJob)).resolves.toBe(false);
  });

  it('refuses any other system actor and any user, without a query', async () => {
    const { policy, load } = policyWith(head);
    for (const actor of [
      { kind: 'system' as const, id: 'system:quotation-render' },
      { kind: 'system' as const, id: `system:${PO_RENDER_JOB_PREFIX}-test-seed` },
      { kind: 'user' as const, id: `system:${PO_RENDER_JOB_PREFIX}` },
    ]) {
      await expect(policy.allowsSystemActor(scope, 'v-1', actor)).resolves.toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('lets nobody attach by hand', async () => {
    await expect(policyWith(head).policy.canAttach(scope, 'v-1')).resolves.toBe(false);
  });

  it('names the vendor party for authz, and nothing for a version that is not there', async () => {
    await expect(policyWith(head).policy.resource(scope, 'v-1')).resolves.toMatchObject({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      vendorPartyId: 'vendor-1',
    });
    await expect(policyWith(undefined).policy.resource(scope, 'v-1')).resolves.toBeNull();
  });
});
