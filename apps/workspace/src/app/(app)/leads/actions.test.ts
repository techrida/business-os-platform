import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 't', roles: ['sales'] })),
}));

const api = vi.hoisted(() => ({ createLead: vi.fn(), convertLead: vi.fn() }));
vi.mock('@/components/p2/crm/crm-api', () => api);

import { convertLeadAction, createLeadAction } from './actions';

const IDEM = '44444444-4444-4444-8444-444444444444';
const LEAD = '11111111-1111-4111-8111-111111111111';
const GUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function form(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  const fields = {
    title: 'Dispatch automation',
    source: 'referral',
    companyName: 'Binford Ltd.',
    contactName: 'Sunita Shrestha',
    idempotencyKey: IDEM,
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const empty = { values: {}, fieldErrors: {} };

beforeEach(() => vi.clearAllMocks());

describe('createLeadAction', () => {
  it('sends the page key as the idempotency key and goes to the new lead', async () => {
    api.createLead.mockResolvedValue({ id: LEAD });
    await expect(createLeadAction(empty, form())).rejects.toThrow(`NEXT_REDIRECT /leads/${LEAD}`);
    expect(api.createLead).toHaveBeenCalledWith(expect.anything(), expect.anything(), IDEM);
  });

  it('keeps the key after a 5xx or a network error, so a retry cannot create a second lead', async () => {
    api.createLead.mockRejectedValueOnce(new ApiError(503, 'down'));
    const first = await createLeadAction(empty, form());
    expect(first.error).toBeTruthy();
    expect(first.key).toBe(IDEM);

    api.createLead.mockRejectedValueOnce(new TypeError('fetch failed'));
    const second = await createLeadAction(empty, form());
    expect(second.error).toBeTruthy();
    expect(second.key).toBe(IDEM);
  });

  it('rotates the key after a definite 4xx, so the next try is a new request', async () => {
    api.createLead.mockRejectedValueOnce(new ApiError(422, 'refused'));
    const res = await createLeadAction(empty, form());
    expect(res.key).toMatch(GUID_SHAPE);
    expect(res.key).not.toBe(IDEM);
  });

  it.each([
    'The first request with this Idempotency-Key did not finish',
    'This Idempotency-Key was released while it was being checked',
  ])('keeps the key after the in-progress 409 "%s", so the retry replays', async (message) => {
    api.createLead.mockRejectedValueOnce(
      new ApiError(409, message, { error: { code: 'conflict', message, correlationId: 'c' } }),
    );
    const res = await createLeadAction(empty, form());
    expect(res.key).toBe(IDEM);
  });

  it('keeps the unused key when the form is refused before any call', async () => {
    const res = await createLeadAction(empty, form({ title: '' }));
    expect(res.fieldErrors['title']).toBeTruthy();
    expect(res.key).toBe(IDEM);
    expect(api.createLead).not.toHaveBeenCalled();
  });

  it('replaces a missing or tampered key with a fresh one', async () => {
    api.createLead.mockResolvedValue({ id: LEAD });
    await expect(createLeadAction(empty, form({ idempotencyKey: 'x y' }))).rejects.toThrow();
    const sent = api.createLead.mock.calls[0]?.[2] as string;
    expect(sent).toMatch(GUID_SHAPE);
    expect(sent).not.toBe('x y');
  });
});

const apiError = (status: number, code: string) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678' },
  });

const convertForm = () => {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    leadId: LEAD,
    idempotencyKey: IDEM,
    customerMode: 'create',
    legalName: 'Himalayan Construction Pvt. Ltd.',
    opportunityName: 'Bridge works',
    expectedVersion: '3',
    line1: 'Balaju',
    city: 'Kathmandu',
    contactMode: 'create',
    contactName: 'Sita Rai',
    contactEmail: 'sita@himalayan.example',
  })) {
    f.set(k, v);
  }
  return f;
};

describe('convertLeadAction', () => {
  it.each([
    ['duplicate_pan_vat', 'Another customer already has this PAN/VAT number.'],
    ['primary_contact_exists', 'This customer already has a primary contact.'],
    ['kyb_not_verified', "This customer's verification must be approved first."],
  ])(
    'shows the real sentence for the 409 code %s, and does not ask for a reload',
    async (code, text) => {
      api.convertLead.mockRejectedValue(apiError(409, code));
      const res = await convertLeadAction(empty, convertForm());
      expect(res.error).toBe(text);
      expect(res.reload).toBe(false);
      expect(res.definite).toBe(true);
    },
  );

  it('puts a 422 contact_email_required next to the contact, not as a generic failure', async () => {
    api.convertLead.mockRejectedValue(apiError(422, 'contact_email_required'));
    const res = await convertLeadAction(empty, convertForm());
    expect(res.fieldErrors.contactId).toMatch(/no email/i);
    expect(res.error).toBeUndefined();
    expect(res.definite).toBe(true);
  });

  it('refuses a conversion without a contact before calling the API', async () => {
    const f = convertForm();
    f.delete('contactMode');
    const res = await convertLeadAction(empty, f);
    expect(res.fieldErrors.contactMode).toMatch(/choose a contact/i);
    expect(api.convertLead).not.toHaveBeenCalled();
  });
});
