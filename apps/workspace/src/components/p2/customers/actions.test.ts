import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: () => Promise.resolve({ roles: ['sales'] }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const { revalidatePath } = await import('next/cache');
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
// The live grants from /v1/me; a test swaps them to act as a role an admin edited.
const grants = vi.hoisted(() => ({ live: new Map<string, string>([['customer.write', 'all']]) }));
vi.mock('@/lib/grants', () => ({
  getGrants: () => Promise.resolve(grants.live),
  hasGrant: (g: Map<string, string>, p: string) => g.has(p),
}));

const api = vi.hoisted(() => ({
  createContact: vi.fn(),
  createCustomer: vi.fn(),
  getCustomer: vi.fn(),
  grantCustomerPortalAccess: vi.fn(),
  listCustomers: vi.fn(),
  updateCustomer: vi.fn(),
}));
vi.mock('./api', () => api);

const { addContactAction, createCustomerAction, invitePortalAdminAction, updateCustomerAction } =
  await import('./actions');

const ID = '11111111-1111-4111-8111-111111111111';
const IDEM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const apiError = (status: number, code: string) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678' },
  });

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const createForm = () =>
  form({
    legalName: 'Himalayan Construction Pvt. Ltd.',
    relationship: 'prospect',
    'address.line': 'Balaju',
    'address.city': 'Kathmandu',
    'address.country': 'NP',
    contactName: 'Sita Rai',
    contactEmail: 'sita@himalayan.example',
    contactCountry: 'NP',
    ackDuplicates: 'yes',
    idempotencyKey: IDEM,
  });

beforeEach(() => {
  vi.resetAllMocks();
  grants.live = new Map([['customer.write', 'all']]);
});

describe('the live grants, not the role defaults (audit #5)', () => {
  it('refuses a sales user whose customer.write an admin removed, before calling the API', async () => {
    // The session still says `sales`, whose defaults include customer.write; the live grants do not.
    grants.live = new Map([['customer.read', 'all']]);
    const created = await createCustomerAction({ key: IDEM, errors: {} }, createForm());
    expect(created.error).toMatch(/do not include changing customers/i);
    const contact = await addContactAction(
      { key: IDEM, errors: {}, savedCount: 0 },
      form({ customerId: ID, fullName: 'Sita Rai', country: 'NP', idempotencyKey: IDEM }),
    );
    expect(contact.error).toMatch(/do not include changing customers/i);
    expect(api.createCustomer).not.toHaveBeenCalled();
    expect(api.createContact).not.toHaveBeenCalled();
  });
});

describe('createCustomerAction', () => {
  it('says another customer has the PAN/VAT number, and rotates the key', async () => {
    api.createCustomer.mockRejectedValue(apiError(409, 'duplicate_pan_vat'));
    const res = await createCustomerAction({ key: IDEM, errors: {} }, createForm());
    expect(res.error).toBe('Another customer already has this PAN/VAT number.');
    expect(res.key).not.toBe(IDEM);
  });

  it('sends the customer and its first contact in one create', async () => {
    api.createCustomer.mockResolvedValue({ id: ID });
    await expect(createCustomerAction({ key: IDEM, errors: {} }, createForm())).rejects.toThrow(
      `redirect /customers/${ID}?created=1`,
    );
    expect(api.createCustomer).toHaveBeenCalledTimes(1);
    expect(api.createCustomer.mock.calls[0]?.[1]).toMatchObject({
      legalName: 'Himalayan Construction Pvt. Ltd.',
      contact: { fullName: 'Sita Rai', email: 'sita@himalayan.example' },
    });
  });

  it("sends the address country as the customer's country and the first contact's two phones", async () => {
    api.createCustomer.mockResolvedValue({ id: ID });
    const f = createForm();
    f.set('address.country', 'IN');
    f.set('contactCountry', 'US');
    f.set('contactPhones.0.number', '+9779812345678');
    f.set('contactPhones.0.country', 'NP');
    f.set('contactPhones.0.label', '');
    f.set('contactPhones.0.isPrimary', 'false');
    f.set('contactPhones.1.number', '+14155552671');
    f.set('contactPhones.1.country', 'US');
    f.set('contactPhones.1.label', 'work');
    f.set('contactPhones.1.isPrimary', 'true');
    await expect(createCustomerAction({ key: IDEM, errors: {} }, f)).rejects.toThrow(/redirect/);
    expect(api.createCustomer.mock.calls[0]?.[1]).toMatchObject({
      country: 'IN',
      address: { line: 'Balaju', city: 'Kathmandu' },
      contact: {
        country: 'US',
        phones: [
          { country: 'NP', e164: '+9779812345678', isPrimary: false },
          { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
        ],
      },
    });
  });

  it('refuses an address without a country before calling the API', async () => {
    const f = createForm();
    f.delete('address.country');
    const res = await createCustomerAction({ key: IDEM, errors: {} }, f);
    // Only the country is refused: the line and city posted under `address.` were read.
    expect(res.errors).toEqual({ country: "Choose the company's country." });
    expect(api.createCustomer).not.toHaveBeenCalled();
  });

  it('refuses a Nepal customer with an 8-digit PAN, and saves a foreign one without a PAN', async () => {
    const short = createForm();
    short.set('panVatNo', '30123456');
    const refused = await createCustomerAction({ key: IDEM, errors: {} }, short);
    expect(refused.errors.panVatNo).toMatch(/9 digits/);
    expect(api.createCustomer).not.toHaveBeenCalled();

    api.createCustomer.mockResolvedValue({ id: ID });
    const foreign = createForm();
    foreign.set('address.country', 'IN');
    await expect(createCustomerAction({ key: IDEM, errors: {} }, foreign)).rejects.toThrow(
      /redirect/,
    );
    expect(api.createCustomer.mock.calls[0]?.[1]).toMatchObject({ country: 'IN' });
  });

  it('puts a bad phone back on the row the form posted it in', async () => {
    const f = createForm();
    f.set('contactPhones.0.number', '');
    f.set('contactPhones.0.country', 'NP');
    f.set('contactPhones.0.isPrimary', 'true');
    f.set('contactPhones.1.number', '+14155552671');
    f.set('contactPhones.1.country', 'NP');
    f.set('contactPhones.1.isPrimary', 'false');
    const res = await createCustomerAction({ key: IDEM, errors: {} }, f);
    const errors = res.errors as { phoneRows?: (string | undefined)[] };
    expect(errors.phoneRows?.[0]).toBeUndefined();
    expect(errors.phoneRows?.[1]).toMatch(/Nepal number starts with \+977/);
    expect(api.createCustomer).not.toHaveBeenCalled();
  });

  it('refuses a customer without a first contact email before calling the API', async () => {
    const f = createForm();
    f.delete('contactEmail');
    const res = await createCustomerAction({ key: IDEM, errors: {} }, f);
    expect(res.errors.contactEmail).toMatch(/email/i);
    expect(api.createCustomer).not.toHaveBeenCalled();
  });
});

describe('addContactAction', () => {
  it('turns a lost race for the main contact into a toast, keeps the form and reloads the page data', async () => {
    api.createContact.mockRejectedValue(apiError(409, 'primary_contact_exists'));
    const res = await addContactAction(
      { key: IDEM, errors: {}, savedCount: 0 },
      form({
        customerId: ID,
        fullName: 'Sita Rai',
        country: 'NP',
        isPrimary: 'on',
        idempotencyKey: IDEM,
      }),
    );
    expect(res.primaryTaken).toMatch(/already has a main contact/i);
    expect(res.error).toBeUndefined();
    expect(res.savedCount).toBe(0);
    expect(revalidatePath).toHaveBeenCalledWith(`/customers/${ID}`);
  });

  it('needs an email while the page says the customer has none, before calling the API', async () => {
    const res = await addContactAction(
      { key: IDEM, errors: {}, savedCount: 0 },
      form({
        customerId: ID,
        fullName: 'Sita Rai',
        country: 'NP',
        requireEmail: 'yes',
        idempotencyKey: IDEM,
      }),
    );
    expect(res.errors.email).toMatch(/no contact with an email/i);
    expect(api.createContact).not.toHaveBeenCalled();
  });

  it('puts the API refusal 422 contact_email_required on the email field', async () => {
    api.createContact.mockRejectedValue(apiError(422, 'contact_email_required'));
    const res = await addContactAction(
      { key: IDEM, errors: {}, savedCount: 0 },
      form({ customerId: ID, fullName: 'Sita Rai', country: 'NP', idempotencyKey: IDEM }),
    );
    expect(res.errors.email).toMatch(/no contact with an email/i);
    expect(res.error).toBeUndefined();
  });

  it("sends the contact's country and two phones in different countries intact", async () => {
    api.createContact.mockResolvedValue({ id: ID });
    await addContactAction(
      { key: IDEM, errors: {}, savedCount: 0 },
      form({
        customerId: ID,
        fullName: 'Sita Rai',
        country: 'IN',
        'phones.0.number': '+9779812345678',
        'phones.0.country': 'NP',
        'phones.0.isPrimary': 'true',
        'phones.1.number': '+14155552671',
        'phones.1.country': 'US',
        'phones.1.label': 'mobile',
        'phones.1.isPrimary': 'false',
        idempotencyKey: IDEM,
      }),
    );
    expect(api.createContact.mock.calls[0]?.[2]).toEqual({
      fullName: 'Sita Rai',
      country: 'IN',
      isPrimary: false,
      phones: [
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'US', e164: '+14155552671', label: 'mobile', isPrimary: false },
      ],
    });
  });

  it('hands back a saved message (shown as a toast) and resets the form', async () => {
    api.createContact.mockResolvedValue({ id: ID });
    const res = await addContactAction(
      { key: IDEM, errors: {}, savedCount: 2 },
      form({
        customerId: ID,
        fullName: 'Sita Rai',
        country: 'NP',
        email: 'sita@x.example',
        idempotencyKey: IDEM,
      }),
    );
    expect(res.saved).toBe('Sita Rai was added.');
    expect(res.savedCount).toBe(3);
  });
});

describe('updateCustomerAction', () => {
  const original = {
    id: ID,
    legalName: 'Old name',
    relationship: 'prospect',
    country: 'NP',
    address: { line: 'Balaju', city: 'Kathmandu' },
    version: 2,
  };
  const editForm = () =>
    form({
      customerId: ID,
      expectedVersion: '2',
      legalName: 'New name',
      relationship: 'prospect',
      'address.line': 'Balaju',
      'address.city': 'Kathmandu',
      'address.country': 'NP',
    });

  it('shows the real duplicate PAN/VAT sentence, not "someone else changed this"', async () => {
    api.getCustomer.mockResolvedValue(original);
    api.updateCustomer.mockRejectedValue(apiError(409, 'duplicate_pan_vat'));
    const res = await updateCustomerAction({ key: IDEM, errors: {} }, editForm());
    expect(res.error).toBe('Another customer already has this PAN/VAT number.');
    expect(res.reload).toBeUndefined();
  });

  it('a save with nothing changed is a neutral notice, not an error (R6Q5)', async () => {
    api.getCustomer.mockResolvedValue(original);
    const f = editForm();
    f.set('legalName', 'Old name');
    const res = await updateCustomerAction({ key: IDEM, errors: {} }, f);
    expect(api.updateCustomer).not.toHaveBeenCalled();
    expect(res.error).toBeUndefined();
    expect(res.notice).toBe('Nothing changed, so there is nothing to save.');
  });

  it('saves a verified customer whose disabled country control posts nothing (R6AE)', async () => {
    api.getCustomer.mockResolvedValue(original);
    api.updateCustomer.mockResolvedValue({ ...original, industry: 'Retail' });
    const f = editForm();
    f.delete('address.country');
    f.set('legalName', 'Old name');
    f.set('industry', 'Retail');
    await expect(updateCustomerAction({ key: IDEM, errors: {} }, f)).rejects.toThrow(
      `redirect /customers/${ID}?saved=1`,
    );
    expect(api.updateCustomer).toHaveBeenCalled();
  });

  it('keeps the reload wording for a plain version conflict', async () => {
    api.getCustomer.mockResolvedValue(original);
    api.updateCustomer.mockRejectedValue(apiError(409, 'conflict'));
    const res = await updateCustomerAction({ key: IDEM, errors: {} }, editForm());
    expect(res.error).toMatch(/Someone else changed this customer/);
    expect(res.reload).toBe(true);
  });
});

describe('invitePortalAdminAction (F1-Q31)', () => {
  const CONTACT = '33333333-3333-4333-8333-333333333333';
  const start = { key: IDEM, errors: {}, savedCount: 0 };
  const invite = (fields: Record<string, string> = {}) =>
    invitePortalAdminAction(
      start,
      form({ customerId: ID, contactId: CONTACT, idempotencyKey: IDEM, ...fields }),
    );

  it('sends the chosen contact id (never an email) under the page key, and confirms with a toast', async () => {
    api.grantCustomerPortalAccess.mockResolvedValue({ email: 'ana@acme.test', inviteSent: true });
    const out = await invite();
    expect(api.grantCustomerPortalAccess).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      CONTACT,
      IDEM,
    );
    expect(out).toMatchObject({
      saved: 'Portal access granted. An invitation was sent to ana@acme.test.',
      savedCount: 1,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/customers/${ID}`);
  });

  it('asks for a contact before calling the API', async () => {
    const out = await invite({ contactId: '' });
    expect(out.errors.contactId).toBe('Choose which contact gets portal access.');
    expect(api.grantCustomerPortalAccess).not.toHaveBeenCalled();
  });

  it.each([
    [
      'first_admin_owner_only',
      "Only this customer's account owner can invite its first portal admin.",
    ],
    ['account_owner_missing', 'This customer has no account owner'],
    ['kyb_not_verified', 'Portal access needs an approved KYB verification.'],
  ])('words the %s refusal for a person', async (code, words) => {
    api.grantCustomerPortalAccess.mockRejectedValue(apiError(409, code));
    const out = await invite();
    expect(out.error).toContain(words);
    expect(out.error).not.toContain('internal wording');
    expect(out.savedCount).toBe(0);
  });

  it('puts a contact that is no longer on the customer (404) on the contact field', async () => {
    api.grantCustomerPortalAccess.mockRejectedValue(apiError(404, 'not_found'));
    const out = await invite();
    expect(out.errors.contactId).toContain('no longer on this customer');
  });

  it('refuses without customer.write and calls nothing', async () => {
    grants.live = new Map();
    const out = await invite();
    expect(out.error).toContain('Your roles do not include changing customers');
    expect(api.grantCustomerPortalAccess).not.toHaveBeenCalled();
    grants.live = new Map([['customer.write', 'all']]);
  });
});
