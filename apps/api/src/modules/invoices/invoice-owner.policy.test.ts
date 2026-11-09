// Unit tests of the document owner policy for invoices (no database: the loader is faked). The rules under test: a
// person attaches nothing to an invoice, the invoice render job's system actor adds the PDF only to an issued invoice,
// and everything else is refused (deny by default).
import { describe, expect, it, vi } from 'vitest';

import {
  INVOICE_OWNER_TYPE,
  InvoiceOwnerPolicy,
  type InvoiceOwnerHead,
} from './invoice-owner.policy';

const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' };
const INVOICE = '00000000-0000-4000-8000-000000000011';
const render = { kind: 'system' as const, id: 'system:invoice-render' };

const head = (status: InvoiceOwnerHead['status']): InvoiceOwnerHead => ({
  status,
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  ownerUserId: '00000000-0000-4000-8000-000000000050',
  customerPartyId: '00000000-0000-4000-8000-000000000020',
});

const policyFor = (found: InvoiceOwnerHead | undefined) => {
  const load = vi.fn().mockResolvedValue(found);
  return { policy: new InvoiceOwnerPolicy(load), load };
};

describe('InvoiceOwnerPolicy', () => {
  it('is the policy of the invoice owner type', () => {
    expect(INVOICE_OWNER_TYPE).toBe('invoice');
    expect(policyFor(undefined).policy.ownerType).toBe('invoice');
  });

  it('returns the authz reference of the invoice, and null when it is not in this scope', async () => {
    await expect(policyFor(head('issued')).policy.resource(SCOPE, INVOICE)).resolves.toEqual({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      ownerUserId: '00000000-0000-4000-8000-000000000050',
      customerPartyId: '00000000-0000-4000-8000-000000000020',
      sodUserIds: [],
    });
    await expect(policyFor(undefined).policy.resource(SCOPE, INVOICE)).resolves.toBeNull();
  });

  it.each(['draft', 'submitted', 'returned', 'approved', 'issued', 'discarded'] as const)(
    'lets no person attach to a %s invoice',
    async (status) => {
      await expect(policyFor(head(status)).policy.canAttach(SCOPE, INVOICE)).resolves.toBe(false);
    },
  );

  describe('allowsSystemActor', () => {
    it('allows the render job on an issued invoice', async () => {
      await expect(
        policyFor(head('issued')).policy.allowsSystemActor(SCOPE, INVOICE, render),
      ).resolves.toBe(true);
    });

    it.each(['draft', 'submitted', 'returned', 'approved', 'discarded'] as const)(
      'refuses the render job on a %s invoice',
      async (status) => {
        await expect(
          policyFor(head(status)).policy.allowsSystemActor(SCOPE, INVOICE, render),
        ).resolves.toBe(false);
      },
    );

    it('refuses an invoice that is not found', async () => {
      await expect(
        policyFor(undefined).policy.allowsSystemActor(SCOPE, INVOICE, render),
      ).resolves.toBe(false);
    });

    it('refuses any other job, and a user, without touching the database', async () => {
      const { policy, load } = policyFor(head('issued'));
      await expect(
        policy.allowsSystemActor(SCOPE, INVOICE, { kind: 'system', id: 'system:quotation-render' }),
      ).resolves.toBe(false);
      await expect(
        policy.allowsSystemActor(SCOPE, INVOICE, { kind: 'user', id: 'system:invoice-render' }),
      ).resolves.toBe(false);
      expect(load).not.toHaveBeenCalled();
    });
  });
});
