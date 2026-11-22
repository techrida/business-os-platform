import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['finance'] as string[] }));
const api = vi.hoisted(() => ({
  createPaymentRequest: vi.fn(),
  submitPaymentRequest: vi.fn(),
  cancelPaymentRequest: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: () => Promise.resolve(session) }));
// GET /v1/me for an unedited role answers the role's default grants; a test sets `live` for an edited one.
const grants = vi.hoisted(() => ({ live: undefined as Map<string, string> | undefined }));
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: () =>
      Promise.resolve(
        grants.live ??
          new Map(
            session.roles.flatMap((r) =>
              Object.entries(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS]),
            ),
          ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});
vi.mock('@/lib/api-payables', () => api);
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { createPaymentRequestAction, submitPaymentRequestAction, cancelPaymentRequestAction } =
  await import('./actions');
const id = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const prev = { key };
const form = (extra: Record<string, string> = {}) => {
  const result = new FormData();
  for (const [name, value] of Object.entries({
    idempotencyKey: key,
    requestId: id,
    vendorPartyId: id,
    fromBankAccountId: id,
    currency: 'NPR',
    lineCount: '1',
    'allocation:0:openItemId': id,
    'allocation:0:amount': '111500.00',
    ...extra,
  }))
    result.set(name, value);
  return result;
};

beforeEach(() => {
  session.roles = ['finance'];
  grants.live = undefined;
  vi.clearAllMocks();
});

describe('payment request actions', () => {
  it('creates a settlement and redirects outside the catch block', async () => {
    api.createPaymentRequest.mockResolvedValue({ id });
    await expect(createPaymentRequestAction(prev, form())).rejects.toThrow(
      `REDIRECT /payables/payment-requests/${id}`,
    );
    expect(api.createPaymentRequest).toHaveBeenCalledWith(
      expect.anything(),
      {
        vendorPartyId: id,
        fromBankAccountId: id,
        currency: 'NPR',
        paymentType: 'settlement',
        // The padded "111500.00" goes as a hydrated box posts it (R5 EF2).
        allocations: [{ openItemId: id, amount: '111500' }],
      },
      key,
    );
  });

  it.each(['accountant', 'procurement', 'vendor_user'])(
    'refuses %s before any write',
    async (role) => {
      session.roles = [role];
      expect((await createPaymentRequestAction(prev, form())).error).toMatch(/roles/i);
      expect(api.createPaymentRequest).not.toHaveBeenCalled();
      expect((await submitPaymentRequestAction(prev, form())).error).toMatch(/roles/i);
      expect(api.submitPaymentRequest).not.toHaveBeenCalled();
    },
  );

  it('refuses invalid amounts, missing accounts and excessive line counts', async () => {
    for (const fields of [
      { 'allocation:0:amount': '0' },
      { 'allocation:0:amount': '-1' },
      { fromBankAccountId: '' },
      { lineCount: '201' },
    ]) {
      const out = await createPaymentRequestAction(prev, form(fields));
      expect(out.error ?? out.errors).toBeTruthy();
    }
    expect(api.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('says to remove the space for an amount like "10 50", and keeps the other amount message', async () => {
    const spaced = await createPaymentRequestAction(prev, form({ 'allocation:0:amount': '10 50' }));
    // Old code gave the generic amount sentence, which does not say what is wrong.
    expect(spaced.errors?.['allocations.0.amount']).toBe('Remove the space inside the number.');
    const zero = await createPaymentRequestAction(prev, form({ 'allocation:0:amount': '0' }));
    expect(zero.errors?.['allocations.0.amount']).toBe(
      'Enter an amount above zero, with up to two decimal places.',
    );
    expect(api.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('keeps the key on an uncertain submit and rotates after a definite refusal', async () => {
    api.submitPaymentRequest.mockRejectedValueOnce(new ApiError(503, 'unavailable'));
    expect((await submitPaymentRequestAction(prev, form())).key).toBe(key);
    api.submitPaymentRequest.mockRejectedValueOnce(
      new ApiError(409, 'conflict', {
        error: { code: 'OVER_ALLOCATION', message: 'internal', correlationId: 'correlation-1234' },
      }),
    );
    const out = await submitPaymentRequestAction(prev, form());
    expect(out.key).not.toBe(key);
    expect(out.error).toMatch(/amount|claim|open/i);
  });

  it('sends a request in a currency the company switched off as it is (D56 U16-Q1)', async () => {
    // Payment requests are exempt from the switch-off: the action reads no enabled list and the API accepts it.
    api.createPaymentRequest.mockResolvedValue({ id });
    await expect(createPaymentRequestAction(prev, form({ currency: 'INR' }))).rejects.toThrow(
      `REDIRECT /payables/payment-requests/${id}`,
    );
    expect(api.createPaymentRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currency: 'INR' }),
      key,
    );
  });

  it('still names the currency if an older API refuses it as switched off (422), and rotates the key', async () => {
    // What an API from before the exemption sent: `bad_request`, with only the message naming the currency.
    api.createPaymentRequest.mockRejectedValueOnce(
      new ApiError(422, 'refused', {
        error: {
          code: 'bad_request',
          message: 'Currency INR is not enabled for this company',
          correlationId: 'correlation-1234',
        },
      }),
    );
    const out = await createPaymentRequestAction(prev, form({ currency: 'INR' }));
    // Fails on the old code: every unnamed 422 read "The platform did not accept this request".
    expect(out.error).toBe(
      'INR is switched off for your company. Choose another currency, or ask an administrator to switch it on in Settings.',
    );
    expect(out.key).not.toBe(key);
  });

  it.each([
    ['BANK_ACCOUNT_INVALID', /not an active account of your company/],
    ['BANK_ACCOUNT_CURRENCY_MISMATCH', /different currency/],
  ])(
    'shows a refused paying account (422 %s) under its field and rotates the key',
    async (code, words) => {
      api.createPaymentRequest.mockRejectedValueOnce(
        new ApiError(422, 'refused', {
          error: { code, message: 'internal', correlationId: 'correlation-1234' },
        }),
      );
      const out = await createPaymentRequestAction(prev, form());
      expect(out.errors?.['fromBankAccountId']).toMatch(words);
      expect(out.error).toBeUndefined();
      expect(out.key).not.toBe(key);
      // The submit dialog has no such field: it shows the same words as its refusal.
      api.submitPaymentRequest.mockRejectedValueOnce(
        new ApiError(422, 'refused', {
          error: { code, message: 'internal', correlationId: 'correlation-1234' },
        }),
      );
      expect((await submitPaymentRequestAction(prev, form())).error).toMatch(words);
    },
  );

  it('asks for a bank account when none was chosen', async () => {
    const out = await createPaymentRequestAction(prev, form({ fromBankAccountId: '' }));
    expect(out.errors?.['fromBankAccountId']).toBe('Choose the bank account to pay from.');
    expect(api.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('requires a cancellation reason and sends it trimmed with the key', async () => {
    expect(
      (await cancelPaymentRequestAction(prev, form({ reason: ' ' }))).errors?.['reason'],
    ).toBeTruthy();
    expect(api.cancelPaymentRequest).not.toHaveBeenCalled();
    api.cancelPaymentRequest.mockResolvedValue({ id });
    expect(
      (await cancelPaymentRequestAction(prev, form({ reason: ' Wrong invoice ' }))).done,
    ).toMatch(/cancelled/i);
    expect(api.cancelPaymentRequest).toHaveBeenCalledWith(
      expect.anything(),
      id,
      'Wrong invoice',
      key,
    );
  });

  // The request's page opens on the live grants; its submit and cancel agree with it.
  it('lets a Management approver granted payables.payment.request submit and cancel the request', async () => {
    session.roles = ['management'];
    grants.live = new Map([['payables.payment.request', 'all']]);
    api.submitPaymentRequest.mockResolvedValue({ id });
    api.cancelPaymentRequest.mockResolvedValue({ id });
    expect((await submitPaymentRequestAction(prev, form())).done).toMatch(/approvals inbox/i);
    expect((await cancelPaymentRequestAction(prev, form({ reason: 'Paid by cash' }))).done).toMatch(
      /cancelled/i,
    );
  });

  // Create reads the live grants too (fails on the old code, which read the role defaults).
  it('lets a role granted payables.payment.request at own scope create a request', async () => {
    session.roles = ['accountant'];
    grants.live = new Map([['payables.payment.request', 'own']]);
    api.createPaymentRequest.mockResolvedValue({ id });
    await expect(createPaymentRequestAction(prev, form())).rejects.toThrow(
      `REDIRECT /payables/payment-requests/${id}`,
    );
    expect(api.createPaymentRequest).toHaveBeenCalledOnce();
  });

  it('refuses Finance whose payables.payment.request an admin removed, before any write', async () => {
    grants.live = new Map([['payables.bill.read', 'all']]);
    expect((await createPaymentRequestAction(prev, form())).error).toMatch(/roles/i);
    expect(api.createPaymentRequest).not.toHaveBeenCalled();
    expect((await submitPaymentRequestAction(prev, form())).error).toMatch(/roles/i);
    expect((await cancelPaymentRequestAction(prev, form({ reason: 'x y' }))).error).toMatch(
      /roles/i,
    );
    expect(api.submitPaymentRequest).not.toHaveBeenCalled();
    expect(api.cancelPaymentRequest).not.toHaveBeenCalled();
  });
});
