import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE } from '../action-state';

// The workflow Server Actions check the spec with the write contract before calling the API, so a threshold the
// contract refuses never reaches it. The guard and the API client are the only stand-ins.

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../guard', () => ({ requireSection: () => Promise.resolve({ accessToken: 't' }) }));
const api = vi.hoisted(() => ({
  addApprovalGroupMember: vi.fn(),
  addWorkflowVersion: vi.fn(),
  createApprovalGroup: vi.fn(),
  createDelegation: vi.fn(),
  createWorkflow: vi.fn(),
  deleteApprovalGroup: vi.fn(),
  publishWorkflowVersion: vi.fn(),
  removeApprovalGroupMember: vi.fn(),
  revokeDelegation: vi.fn(),
}));
vi.mock('@/lib/api-admin', () => api);

const { createWorkflowAction, saveDraftAction } = await import('./actions');

const specWith = (value: string) =>
  JSON.stringify({
    documentType: 'test_memo',
    steps: [{ id: 'review', kind: 'role', role: 'finance', reason: 'Review' }],
    rules: [
      {
        id: 'big',
        when: { field: 'amountNpr', op: 'gt', value },
        add: { id: 'founder', kind: 'role', role: 'founder', reason: 'Founder approves' },
        reason: 'Large amounts',
      },
    ],
  });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.addWorkflowVersion.mockResolvedValue({ version: 2 });
  api.createWorkflow.mockResolvedValue({ version: 1 });
});

describe('workflow amount threshold', () => {
  it('refuses a negative threshold on save and never calls the API', async () => {
    const state = await saveDraftAction(IDLE, form({ key: 'test_memo', spec: specWith('-5') }));
    expect(state).toMatchObject({ status: 'error' });
    expect(state.message).toContain('Enter an amount of zero or more.');
    expect(api.addWorkflowVersion).not.toHaveBeenCalled();
  });

  it('refuses a negative threshold on create and never calls the API', async () => {
    const state = await createWorkflowAction(
      IDLE,
      form({ key: 'test_memo', name: 'Test memo', spec: specWith('-0.01') }),
    );
    expect(state.message).toContain('Enter an amount of zero or more.');
    expect(api.createWorkflow).not.toHaveBeenCalled();
  });

  it('sends an unsigned threshold to the API as typed', async () => {
    const state = await saveDraftAction(IDLE, form({ key: 'test_memo', spec: specWith('100000') }));
    expect(state).toMatchObject({ status: 'ok' });
    expect(api.addWorkflowVersion).toHaveBeenCalledWith(
      expect.anything(),
      'test_memo',
      expect.objectContaining({
        rules: [
          expect.objectContaining({ when: { field: 'amountNpr', op: 'gt', value: '100000' } }),
        ],
      }),
    );
  });
});
