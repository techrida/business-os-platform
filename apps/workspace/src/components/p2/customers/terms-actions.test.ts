// The Commercial terms card's server actions: each one checks its own grant (Finance sets limits and Management
// changes owners without customer.write), validates before anything is sent, sends one field with the version the
// page rendered (none before the first terms save) and, for the terms, the legal entity the page was rendered for,
// and words every refusal: 403, a stale 409 (the page data is reloaded), a 409 for an entity switched in another tab
// (not reloaded), a refused payment term (422), a refused owner (400), a missing customer and a lost connection.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: ['finance'] }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const { revalidatePath } = await import('next/cache');
const grants = vi.hoisted(() => ({ live: new Map<string, string>() }));
vi.mock('@/lib/grants', () => ({
  getGrants: () => Promise.resolve(grants.live),
  hasGrant: (g: Map<string, string>, p: string) => g.has(p),
}));
const api = vi.hoisted(() => ({ updateCustomer: vi.fn(), updateCustomerTerms: vi.fn() }));
vi.mock('./api', () => api);

const { changeOwnerAction, setCreditLimitAction, setPaymentTermAction } =
  await import('./terms-actions');
const {
  ENTITY_CHANGED,
  LIMIT_INVALID,
  LIMIT_REQUIRED,
  NO_PERMISSION,
  NOTHING_CHANGED,
  OWNER_REFUSED,
  TERMS_START,
} = await import('./terms-form');

const ID = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TERM = '44444444-4444-4444-8444-444444444444';
/** The acting entity the page was rendered for. */
const ORG = '55555555-5555-4555-8555-555555555555';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const apiError = (status: number, error: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code: 'x', message: 'internal wording', correlationId: 'corr-12345678', ...error },
  });

const limit = (fields: Record<string, string>) =>
  setCreditLimitAction(
    TERMS_START,
    form({
      customerId: ID,
      organizationId: ORG,
      expectedVersion: '3',
      currentCreditLimit: '',
      ...fields,
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  grants.live = new Map([['customers.credit_limit.write', 'all']]);
  api.updateCustomerTerms.mockResolvedValue({});
  api.updateCustomer.mockResolvedValue({});
});

describe('setCreditLimitAction', () => {
  it('lets Finance (no customer.write) set a limit, sending NPR digits and the rendered version', async () => {
    const out = await limit({ limitMode: 'limit', creditLimit: '1,00,000.00' });
    expect(api.updateCustomerTerms).toHaveBeenCalledWith(expect.anything(), ID, {
      organizationId: ORG,
      creditLimit: '100000.00',
      expectedVersion: 3,
    });
    expect(out).toEqual({ errors: {}, saved: 'Credit limit saved.', savedCount: 1 });
    expect(revalidatePath).toHaveBeenCalledWith(`/customers/${ID}`);
  });

  it('sends null for No limit, and 0.00 as a real limit', async () => {
    await limit({ limitMode: 'none', currentCreditLimit: '5000.00' });
    expect(api.updateCustomerTerms).toHaveBeenLastCalledWith(expect.anything(), ID, {
      organizationId: ORG,
      creditLimit: null,
      expectedVersion: 3,
    });
    await limit({ limitMode: 'limit', creditLimit: '0.00' });
    expect(api.updateCustomerTerms).toHaveBeenLastCalledWith(expect.anything(), ID, {
      organizationId: ORG,
      creditLimit: '0.00',
      expectedVersion: 3,
    });
  });

  it('leaves the version out on the first save (no terms row yet)', async () => {
    await limit({ limitMode: 'limit', creditLimit: '500', expectedVersion: '' });
    expect(api.updateCustomerTerms).toHaveBeenCalledWith(expect.anything(), ID, {
      organizationId: ORG,
      creditLimit: '500',
    });
  });

  it.each([
    ['', LIMIT_REQUIRED],
    ['12.345', LIMIT_INVALID],
    ['-100', LIMIT_INVALID],
  ])('refuses %j under the field before sending', async (creditLimit, message) => {
    const out = await limit({ limitMode: 'limit', creditLimit });
    expect(out.errors.value).toBe(message);
    expect(api.updateCustomerTerms).not.toHaveBeenCalled();
  });

  it('refuses a save that changes nothing, comparing 100000 with 100000.00', async () => {
    const same = await limit({
      limitMode: 'limit',
      creditLimit: '1,00,000',
      currentCreditLimit: '100000.00',
    });
    expect(same.notice).toBe(NOTHING_CHANGED);
    const stillNone = await limit({ limitMode: 'none', currentCreditLimit: '' });
    expect(stillNone.notice).toBe(NOTHING_CHANGED);
    expect(api.updateCustomerTerms).not.toHaveBeenCalled();
  });

  it('refuses without the credit limit grant before calling the API (Management)', async () => {
    grants.live = new Map([['customers.owner.write', 'all']]);
    const out = await limit({ limitMode: 'limit', creditLimit: '500' });
    expect(out.error).toBe(NO_PERMISSION.creditLimit);
    expect(api.updateCustomerTerms).not.toHaveBeenCalled();
  });

  it('refuses a tampered version or customer id as an incomplete form', async () => {
    expect((await limit({ limitMode: 'none', expectedVersion: '0' })).error).toMatch(/incomplete/i);
    expect((await limit({ limitMode: 'none', customerId: 'x' })).error).toMatch(/incomplete/i);
    expect(api.updateCustomerTerms).not.toHaveBeenCalled();
  });

  it('on a stale version says so and reloads the page data, keeping the dialog open', async () => {
    api.updateCustomerTerms.mockRejectedValue(apiError(409, { code: 'conflict' }));
    const out = await limit({ limitMode: 'limit', creditLimit: '500' });
    expect(out.stale).toBe(true);
    expect(out.error).toMatch(/someone else changed this customer's terms/i);
    expect(out.savedCount).toBe(0);
    expect(revalidatePath).toHaveBeenCalledWith(`/customers/${ID}`);
  });

  it('refuses a missing or tampered entity id as an incomplete form', async () => {
    expect((await limit({ limitMode: 'none', organizationId: '' })).error).toMatch(/incomplete/i);
    expect((await limit({ limitMode: 'none', organizationId: 'TA' })).error).toMatch(/incomplete/i);
    expect(api.updateCustomerTerms).not.toHaveBeenCalled();
  });

  it('on an entity switched in another tab (409 entity_changed) says so, without reloading the page data', async () => {
    api.updateCustomerTerms.mockRejectedValue(
      apiError(409, { code: 'conflict', reason: 'entity_changed' }),
    );
    const out = await limit({ limitMode: 'limit', creditLimit: '500' });
    expect(out).toEqual({
      errors: {},
      error: ENTITY_CHANGED,
      entityChanged: true,
      savedCount: 0,
    });
    expect(out.error).toMatch(/reload the page/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('words a 403 from the API (grant removed after the page loaded), keeping the dialog to show it', async () => {
    api.updateCustomerTerms.mockRejectedValue(
      apiError(403, { code: 'forbidden', reason: 'no_permission' }),
    );
    const out = await limit({ limitMode: 'limit', creditLimit: '500' });
    expect(out.error).toBe(NO_PERMISSION.creditLimit);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('words a missing customer and a lost connection, never the internal text', async () => {
    api.updateCustomerTerms.mockRejectedValueOnce(apiError(404, { code: 'not_found' }));
    expect((await limit({ limitMode: 'limit', creditLimit: '500' })).error).toMatch(
      /no longer available/i,
    );
    api.updateCustomerTerms.mockRejectedValueOnce(new TypeError('fetch failed'));
    const lost = await limit({ limitMode: 'limit', creditLimit: '500' });
    expect(lost.error).toMatch(/did not respond/i);
    expect(lost.error).not.toContain('internal wording');
  });
});

describe('setPaymentTermAction', () => {
  const term = (fields: Record<string, string>) =>
    setPaymentTermAction(
      TERMS_START,
      form({
        customerId: ID,
        organizationId: ORG,
        expectedVersion: '2',
        currentPaymentTermId: '',
        ...fields,
      }),
    );

  beforeEach(() => {
    grants.live = new Map([['customer.write', 'all']]);
  });

  it('sends the chosen term, and null to clear it', async () => {
    expect(await term({ paymentTermId: TERM })).toMatchObject({ saved: 'Payment terms saved.' });
    expect(api.updateCustomerTerms).toHaveBeenLastCalledWith(expect.anything(), ID, {
      organizationId: ORG,
      paymentTermId: TERM,
      expectedVersion: 2,
    });
    await term({ paymentTermId: '', currentPaymentTermId: TERM });
    expect(api.updateCustomerTerms).toHaveBeenLastCalledWith(expect.anything(), ID, {
      organizationId: ORG,
      paymentTermId: null,
      expectedVersion: 2,
    });
  });

  it('refuses Finance (no customer.write) before calling the API', async () => {
    grants.live = new Map([['customers.credit_limit.write', 'all']]);
    expect((await term({ paymentTermId: TERM })).error).toBe(NO_PERMISSION.paymentTerms);
    expect(api.updateCustomerTerms).not.toHaveBeenCalled();
  });

  it('shows a refused term (422) under the field, in the API words, and reloads the list', async () => {
    api.updateCustomerTerms.mockRejectedValue(
      apiError(422, {
        code: 'unprocessable',
        fieldErrors: { paymentTermId: 'This payment term is switched off; choose an active one' },
      }),
    );
    const out = await term({ paymentTermId: TERM });
    expect(out.errors.value).toBe('This payment term is switched off; choose an active one.');
    expect(out.error).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalled();
  });

  it('never words a 422 without a field as "did not respond"', async () => {
    api.updateCustomerTerms.mockRejectedValue(apiError(422, { code: 'unprocessable' }));
    expect((await term({ paymentTermId: TERM })).error).toMatch(/did not accept this change/i);
  });

  it('refuses a missing entity id, and maps a 409 entity_changed without reloading', async () => {
    expect((await term({ paymentTermId: TERM, organizationId: '' })).error).toMatch(/incomplete/i);
    expect(api.updateCustomerTerms).not.toHaveBeenCalled();
    api.updateCustomerTerms.mockRejectedValue(
      apiError(409, { code: 'conflict', reason: 'entity_changed' }),
    );
    const out = await term({ paymentTermId: TERM });
    expect(out).toMatchObject({ error: ENTITY_CHANGED, entityChanged: true, savedCount: 0 });
    expect(out.stale).toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses choosing the term already set', async () => {
    const out = await term({ paymentTermId: TERM, currentPaymentTermId: TERM });
    expect(out.notice).toBe(NOTHING_CHANGED);
    expect(api.updateCustomerTerms).not.toHaveBeenCalled();
  });
});

describe('changeOwnerAction', () => {
  const owner = (fields: Record<string, string>) =>
    changeOwnerAction(
      TERMS_START,
      form({ customerId: ID, expectedVersion: '5', currentOwnerUserId: PERSON, ...fields }),
    );

  beforeEach(() => {
    grants.live = new Map([['customers.owner.write', 'all']]);
  });

  it('lets Management send only the owner and the version', async () => {
    const out = await owner({ ownerUserId: OTHER });
    expect(api.updateCustomer).toHaveBeenCalledWith(expect.anything(), ID, {
      ownerUserId: OTHER,
      expectedVersion: 5,
    });
    expect(out).toMatchObject({ saved: 'The account owner was changed.', savedCount: 1 });
  });

  it('refuses Sales (customer.write only) before calling the API', async () => {
    grants.live = new Map([['customer.write', 'all']]);
    expect((await owner({ ownerUserId: OTHER })).error).toBe(NO_PERMISSION.owner);
    expect(api.updateCustomer).not.toHaveBeenCalled();
  });

  it('asks for a person, and refuses the current owner again', async () => {
    expect((await owner({ ownerUserId: '' })).errors.value).toMatch(/choose who owns/i);
    expect((await owner({ ownerUserId: PERSON })).notice).toBe(NOTHING_CHANGED);
    expect(api.updateCustomer).not.toHaveBeenCalled();
  });

  it('needs the customer version the page rendered', async () => {
    expect((await owner({ ownerUserId: OTHER, expectedVersion: '' })).error).toMatch(/incomplete/i);
    expect(api.updateCustomer).not.toHaveBeenCalled();
  });

  it('puts a refused person (400 not_active_staff) under the field and reloads the list', async () => {
    api.updateCustomer.mockRejectedValue(
      apiError(400, { code: 'bad_request', details: { assignmentReason: 'not_active_staff' } }),
    );
    const out = await owner({ ownerUserId: OTHER });
    expect(out.errors.value).toBe(OWNER_REFUSED);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it('on a stale customer version says the customer changed', async () => {
    api.updateCustomer.mockRejectedValue(apiError(409, { code: 'conflict' }));
    const out = await owner({ ownerUserId: OTHER });
    expect(out.stale).toBe(true);
    expect(out.error).toMatch(/someone else changed this customer while/i);
  });
});
