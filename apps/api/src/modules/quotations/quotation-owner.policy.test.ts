// Unit tests of the document owner policy for quotation versions (no database: the loader is faked). The rules
// under test: a user attaches only while the version is a draft, the render job's system actor adds the generated
// PDF only to an approved version, and everything else is refused (deny by default).
import { describe, expect, it, vi } from 'vitest';

import {
  QUOTATION_OWNER_TYPE,
  QuotationOwnerPolicy,
  type QuotationOwnerHead,
} from './quotation-owner.policy';

const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' };
const VERSION = '00000000-0000-4000-8000-000000000011';
const render = { kind: 'system' as const, id: 'system:quotation-render' };

const head = (status: QuotationOwnerHead['status']): QuotationOwnerHead => ({
  status,
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  ownerUserId: '00000000-0000-4000-8000-000000000050',
  customerPartyId: '00000000-0000-4000-8000-000000000020',
});

const policyFor = (found: QuotationOwnerHead | undefined) => {
  const load = vi.fn().mockResolvedValue(found);
  return { policy: new QuotationOwnerPolicy(load), load };
};

describe('QuotationOwnerPolicy', () => {
  it('is the policy of the quotation_version owner type', () => {
    expect(QUOTATION_OWNER_TYPE).toBe('quotation_version');
    expect(policyFor(undefined).policy.ownerType).toBe('quotation_version');
  });

  describe('resource', () => {
    it('returns the authz reference of the version, owned by the quotation owner', async () => {
      const { policy, load } = policyFor(head('draft'));
      await expect(policy.resource(SCOPE, VERSION)).resolves.toEqual({
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        ownerUserId: '00000000-0000-4000-8000-000000000050',
        customerPartyId: '00000000-0000-4000-8000-000000000020',
        sodUserIds: [],
      });
      expect(load).toHaveBeenCalledWith(SCOPE, VERSION, undefined);
    });

    it('returns null when the version is not found in this scope', async () => {
      await expect(policyFor(undefined).policy.resource(SCOPE, VERSION)).resolves.toBeNull();
    });
  });

  describe('canAttach (a user)', () => {
    it('allows a draft', async () => {
      await expect(policyFor(head('draft')).policy.canAttach(SCOPE, VERSION)).resolves.toBe(true);
    });

    it.each([
      'submitted',
      'returned',
      'approved',
      'sent',
      'accepted',
      'rejected',
      'expired',
      'cancelled',
      'superseded',
    ] as const)('refuses a %s version', async (status) => {
      await expect(policyFor(head(status)).policy.canAttach(SCOPE, VERSION)).resolves.toBe(false);
    });

    it('refuses a version that does not exist', async () => {
      await expect(policyFor(undefined).policy.canAttach(SCOPE, VERSION)).resolves.toBe(false);
    });

    it('asks for a share lock only when it runs inside a transaction', async () => {
      const tx = {} as never;
      const inTx = policyFor(head('draft'));
      await inTx.policy.canAttach(SCOPE, VERSION, tx);
      expect(inTx.load).toHaveBeenCalledWith(SCOPE, VERSION, { tx, lock: 'share' });
      const outside = policyFor(head('draft'));
      await outside.policy.canAttach(SCOPE, VERSION);
      expect(outside.load).toHaveBeenCalledWith(SCOPE, VERSION, undefined);
    });
  });

  describe('allowsSystemActor (a job)', () => {
    it('allows the render job on an approved version', async () => {
      await expect(
        policyFor(head('approved')).policy.allowsSystemActor(SCOPE, VERSION, render),
      ).resolves.toBe(true);
    });

    it('allows a render job whose id only starts with quotation-render', async () => {
      await expect(
        policyFor(head('approved')).policy.allowsSystemActor(SCOPE, VERSION, {
          kind: 'system',
          id: 'system:quotation-render-retry',
        }),
      ).resolves.toBe(true);
    });

    it.each([
      'draft',
      'submitted',
      'returned',
      'sent',
      'accepted',
      'rejected',
      'expired',
      'cancelled',
      'superseded',
    ] as const)('refuses the render job on a %s version', async (status) => {
      await expect(
        policyFor(head(status)).policy.allowsSystemActor(SCOPE, VERSION, render),
      ).resolves.toBe(false);
    });

    it('refuses every other system actor, even on an approved version', async () => {
      const { policy } = policyFor(head('approved'));
      for (const id of [
        'system:quotation-expiry',
        'system:docs-scan',
        'system:render-quotation',
        'system:',
        'quotation-render',
        'user:quotation-render',
      ]) {
        await expect(
          policy.allowsSystemActor(SCOPE, VERSION, { kind: 'system', id }),
        ).resolves.toBe(false);
      }
    });

    it('refuses an actor that is not a system actor, whatever its id says', async () => {
      const { policy } = policyFor(head('approved'));
      for (const kind of ['user', 'zitadel', 'seed'] as const) {
        await expect(
          policy.allowsSystemActor(SCOPE, VERSION, { kind, id: 'system:quotation-render' }),
        ).resolves.toBe(false);
      }
    });

    it('refuses when the version does not exist', async () => {
      await expect(
        policyFor(undefined).policy.allowsSystemActor(SCOPE, VERSION, render),
      ).resolves.toBe(false);
    });
  });
});
