import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../platform/db/tx';
import type { CounterpartyPrincipal } from '../../platform/documents/documents.ports';
import {
  type PaymentOwnerHead,
  PaymentIntakeOwnerPolicy,
  PaymentOwnerPolicy,
} from './payment-owner.policy';

const scope = { tenantId: 't1', organizationId: 'o1' };
const tx = {} as DbTransaction;

function head(over: Partial<PaymentOwnerHead> = {}): PaymentOwnerHead {
  return {
    status: 'submitted',
    tenantId: 't1',
    organizationId: 'o1',
    customerPartyId: 'cust-1',
    submittedBy: 'u1',
    ...over,
  };
}

function customer(partyId: string): CounterpartyPrincipal {
  return { kind: 'customer', userId: 'pu1', partyId, tenantId: 't1', organizationId: 'o1' };
}

describe('PaymentOwnerPolicy', () => {
  it('names the payment for authz, and null for an unknown one', async () => {
    const policy = new PaymentOwnerPolicy((_s, id) =>
      Promise.resolve(id === 'p1' ? head() : undefined),
    );
    expect(await policy.resource(scope, 'p1')).toMatchObject({
      customerPartyId: 'cust-1',
      ownerUserId: 'u1',
    });
    expect(await policy.resource(scope, 'nope')).toBeNull();
  });

  it('takes attachments only while submitted', async () => {
    for (const [status, allowed] of [
      ['submitted', true],
      ['verified', false],
      ['rejected', false],
      ['withdrawn', false],
      ['reversed', false],
    ] as const) {
      const policy = new PaymentOwnerPolicy(() => Promise.resolve(head({ status })));
      expect(await policy.canAttach(scope, 'p1', tx)).toBe(allowed);
    }
  });

  it('lets a customer attach to its own submitted payment only', async () => {
    const policy = new PaymentOwnerPolicy(() => Promise.resolve(head()));
    expect(await policy.allowsCounterparty(customer('cust-1'), 'p1', tx)).toBe(true);
    expect(await policy.allowsCounterparty(customer('cust-2'), 'p1', tx)).toBe(false);
    const decided = new PaymentOwnerPolicy(() => Promise.resolve(head({ status: 'verified' })));
    expect(await decided.allowsCounterparty(customer('cust-1'), 'p1', tx)).toBe(false);
    const missing = new PaymentOwnerPolicy(() => Promise.resolve(undefined));
    expect(await missing.allowsCounterparty(customer('cust-1'), 'p1', tx)).toBe(false);
  });

  it('looks the payment up in the principal’s own tenant and entity', async () => {
    const load = vi.fn(() => Promise.resolve(head()));
    await new PaymentOwnerPolicy(load).allowsCounterparty(customer('cust-1'), 'p1', tx);
    expect(load).toHaveBeenCalledWith(scope, 'p1', tx);
  });

  it('refuses a vendor even when its party matches the payment customer, without loading the payment', async () => {
    const load = vi.fn(() => Promise.resolve(head()));
    const vendor: CounterpartyPrincipal = { ...customer('cust-1'), kind: 'vendor' };

    expect(await new PaymentOwnerPolicy(load).allowsCounterparty(vendor, 'p1', tx)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('allows only the receipt job on a numbered payment', async () => {
    const verified = new PaymentOwnerPolicy(() => Promise.resolve(head({ status: 'verified' })));
    const job = { kind: 'system' as const, id: 'system:payment-receipt' };
    expect(await verified.allowsSystemActor(scope, 'p1', job)).toBe(true);
    expect(await verified.allowsSystemActor(scope, 'p1', { kind: 'system', id: 'system:x' })).toBe(
      false,
    );
    expect(await verified.allowsSystemActor(scope, 'p1', { kind: 'user', id: 'u1' })).toBe(false);
    const submitted = new PaymentOwnerPolicy(() => Promise.resolve(head()));
    expect(await submitted.allowsSystemActor(scope, 'p1', job)).toBe(false);
  });
});

describe('PaymentIntakeOwnerPolicy', () => {
  const policy = new PaymentIntakeOwnerPolicy((_t, id) => Promise.resolve(id === 'cust-1'));

  it('scopes a pre-submit proof to its customer, and refuses a party that is not a customer', async () => {
    expect(await policy.resource(scope, 'cust-1')).toEqual({
      tenantId: 't1',
      organizationId: 'o1',
      customerPartyId: 'cust-1',
      sodUserIds: [],
    });
    expect(await policy.resource(scope, 'vendor-1')).toBeNull();
  });

  it('lets a customer upload for itself only, and no job at all', async () => {
    expect(await policy.allowsCounterparty(customer('cust-1'), 'cust-1')).toBe(true);
    expect(await policy.allowsCounterparty(customer('cust-1'), 'cust-2')).toBe(false);
    expect(await policy.allowsSystemActor()).toBe(false);
  });

  it('refuses a vendor even when its party matches the intake owner', async () => {
    const vendor: CounterpartyPrincipal = { ...customer('cust-1'), kind: 'vendor' };

    expect(await policy.allowsCounterparty(vendor, 'cust-1')).toBe(false);
  });

  it('authorises staff uploads with payment.record instead of documents.upload', () => {
    expect(policy.uploadPermission).toBe('payment.record');
  });
});
