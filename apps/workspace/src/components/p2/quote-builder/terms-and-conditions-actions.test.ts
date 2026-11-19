import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyValues, type BuilderValues } from './model';

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

const api = vi.hoisted(() => ({
  createQuotation: vi.fn(),
  updateDraft: vi.fn(),
  previewVersion: vi.fn(),
  submitVersion: vi.fn(),
}));
vi.mock('./api', () => api);

import { saveDraftAction } from './actions';

const QID = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const TAX = '33333333-3333-4333-8333-333333333333';
const OPP = '55555555-5555-4555-8555-555555555555';
const KEY = '44444444-4444-4444-8444-444444444444';
const ref = { quotationId: QID, versionId: VID };
const create = { mode: 'create', opportunityId: OPP, idempotencyKey: KEY } as const;

function values(): BuilderValues {
  const v = emptyValues({ currency: 'NPR', issueDate: '2026-11-08', validUntil: '2026-12-08' });
  v.lines = [
    { key: 'l1', description: 'Work', uom: 'lot', quantity: '1', unitPrice: '100', taxCodeId: TAX },
  ];
  return v;
}

beforeEach(() => vi.clearAllMocks());

describe('saveDraftAction terms and conditions', () => {
  it('sends the typed terms and conditions on create, and nothing when blank', async () => {
    api.createQuotation.mockResolvedValue({ id: QID });
    const v = { ...values(), termsAndConditions: ' Net 30. ' };
    await expect(saveDraftAction({ ...create, values: v })).rejects.toThrow('NEXT_REDIRECT');
    expect(api.createQuotation.mock.calls[0]?.[1]).toMatchObject({ termsAndConditions: 'Net 30.' });

    api.createQuotation.mockClear();
    await expect(saveDraftAction({ ...create, values: values() })).rejects.toThrow('NEXT_REDIRECT');
    expect(api.createQuotation.mock.calls[0]?.[1]).not.toHaveProperty('termsAndConditions');
  });

  it('on update sends the terms and conditions, and null once they are cleared', async () => {
    api.updateDraft.mockResolvedValue({ version: 4 });
    const update = { mode: 'update', ...ref, expectedVersion: 3 } as const;
    await saveDraftAction({ ...update, values: { ...values(), termsAndConditions: 'Net 30.' } });
    expect(api.updateDraft.mock.calls[0]?.[3]).toMatchObject({ termsAndConditions: 'Net 30.' });

    await saveDraftAction({ ...update, values: { ...values(), termsAndConditions: '' } });
    expect(api.updateDraft.mock.calls[1]?.[3]).toMatchObject({ termsAndConditions: null });
  });
});
