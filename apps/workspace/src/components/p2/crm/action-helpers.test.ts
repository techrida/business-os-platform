import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({ changeLeadStage: vi.fn(), changeOpportunityStage: vi.fn() }));
vi.mock('./crm-api', () => ({
  changeLeadStage: mocks.changeLeadStage,
  changeOpportunityStage: mocks.changeOpportunityStage,
}));

import { runStageMove } from './action-helpers';

const OPP = '22222222-2222-4222-8222-222222222222';

const lostForm = (): FormData => {
  const form = new FormData();
  form.set('recordId', OPP);
  form.set('expectedVersion', '6');
  form.set('stage', 'lost');
  form.set('newLostReason', 'Slow to reply');
  form.set('note', 'Never answered.');
  return form;
};

const conflict = (message: string) =>
  new ApiError(409, 'conflict', { error: { code: 'conflict', message, correlationId: 'c' } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runStageMove, a 409 on a stage move', () => {
  it('names the typed reason when its words are already on the list', async () => {
    mocks.changeOpportunityStage.mockRejectedValueOnce(
      conflict('"Slow to reply" is already on the list of lost reasons'),
    );
    const result = await runStageMove('opportunity', lostForm(), '/opportunities');

    expect(result).toEqual({
      fieldErrors: {
        newLostReason:
          'That reason already exists, or was retired. Use different words, or ask a Founder to restore it.',
      },
    });
  });

  it('keeps the generic error and a reload for a record changed meanwhile', async () => {
    mocks.changeOpportunityStage.mockRejectedValueOnce(
      conflict('The opportunity was changed by someone else'),
    );
    const result = await runStageMove('opportunity', lostForm(), '/opportunities');

    expect(result.fieldErrors).toBeUndefined();
    expect(result.error).toEqual(expect.any(String));
    expect(result.reload).toBe(true);
  });

  it('asks for a logged call, email or meeting, without a reload, when the lead has none', async () => {
    mocks.changeLeadStage.mockRejectedValueOnce(
      new ApiError(409, 'conflict', {
        error: {
          code: 'contact_activity_required',
          message: 'A lead moves to contacted only with a done call, email or meeting',
          correlationId: 'c',
        },
      }),
    );
    const form = new FormData();
    form.set('recordId', OPP);
    form.set('expectedVersion', '3');
    form.set('stage', 'contacted');
    const result = await runStageMove('lead', form, '/leads');

    expect(result).toEqual({
      error: 'Log a call, email or meeting before moving this lead to Contacted.',
      reload: false,
    });
  });

  it('does not take a 409 without the standard error body for a duplicate', async () => {
    mocks.changeOpportunityStage.mockRejectedValueOnce(
      new ApiError(
        409,
        'is already on the list of lost reasons',
        'already on the list of lost reasons',
      ),
    );
    const result = await runStageMove('opportunity', lostForm(), '/opportunities');

    expect(result.fieldErrors).toBeUndefined();
    expect(result.reload).toBe(true);
  });
});
