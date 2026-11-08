import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: () => Promise.resolve({ roles: ['sales'] }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const crm = vi.hoisted(() => ({ convertLead: vi.fn(), createLead: vi.fn() }));
vi.mock('@/components/p2/crm/crm-api', () => crm);

const { convertLeadAction } = await import('./actions');

const LEAD = '11111111-1111-4111-8111-111111111111';
const IDEM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

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
  })) {
    f.set(k, v);
  }
  return f;
};

const empty = { values: {}, fieldErrors: {} };

beforeEach(() => vi.resetAllMocks());

describe('convertLeadAction', () => {
  it.each([
    ['duplicate_pan_vat', 'Another customer already has this PAN/VAT number.'],
    ['primary_contact_exists', 'This customer already has a primary contact.'],
    ['kyb_not_verified', "This customer's verification must be approved first."],
  ])(
    'shows the real sentence for the 409 code %s, and does not ask for a reload',
    async (code, text) => {
      crm.convertLead.mockRejectedValue(apiError(409, code));
      const res = await convertLeadAction(empty, convertForm());
      expect(res.error).toBe(text);
      expect(res.reload).toBe(false);
      expect(res.definite).toBe(true);
    },
  );
});
