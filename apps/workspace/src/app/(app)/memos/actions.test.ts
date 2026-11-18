import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = { orgId: 'org-1', sub: 'user-1' };
const MEMO = '11111111-1111-4111-8111-111111111111';
const DEPT = '44444444-4444-4444-8444-444444444444';
const ME = '66666666-6666-4666-8666-666666666666';
const APPROVER = '77777777-7777-4777-8777-777777777777';

const mocks = vi.hoisted(() => ({
  createMemo: vi.fn(),
  updateMemo: vi.fn(),
  submitMemo: vi.fn(),
  readDraft: vi.fn(),
  tombstoneDraft: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: () => Promise.resolve(session) }));
vi.mock('@/lib/api-kernel', () => ({
  createMemo: mocks.createMemo,
  updateMemo: mocks.updateMemo,
  submitMemo: mocks.submitMemo,
  failureOf: (err: unknown) => ({
    status: 500,
    message: err instanceof Error ? err.message : 'failed',
  }),
}));
vi.mock('@/lib/memo-working-draft', () => ({
  memoDraftAccount: (s: typeof session) => `bound:${s.orgId}:${s.sub}`,
  readDraft: mocks.readDraft,
  tombstoneDraft: mocks.tombstoneDraft,
}));

import { createMemoAction, submitMemoAction, updateMemoAction } from './actions';

const template = JSON.stringify({
  departmentId: DEPT,
  date: '2026-11-18',
  closing: 'Thanks',
  preparedByUserId: ME,
  recommenderUserIds: [],
  approvedByUserId: APPROVER,
});
const formOf = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
};
const good = {
  title: 'Budget',
  body: 'text',
  template,
  draftAccount: 'bound:org-1:user-1',
  draftRevision: 'AAAAAAAAAAAA',
  expectedVersion: '1',
};
const prev = { values: { title: '', body: '' }, fieldErrors: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createMemo.mockResolvedValue({ id: MEMO });
  mocks.updateMemo.mockResolvedValue({ id: MEMO });
  mocks.readDraft.mockResolvedValue({ revision: null, values: null, updatedAt: null });
  mocks.tombstoneDraft.mockResolvedValue({ ok: true, snapshot: { revision: 'T', values: null } });
});

describe('a form left open in another account cannot create or update', () => {
  it.each([
    ['another account', { ...good, draftAccount: 'bound:org-1:someone-else' }],
    ['no binding at all', { ...good, draftAccount: '' }],
  ])('create refuses %s and creates nothing', async (_name, fields) => {
    const out = await createMemoAction(prev, formOf(fields));
    expect(out.error).toMatch(/account changed/);
    expect(mocks.createMemo).not.toHaveBeenCalled();
    expect(mocks.tombstoneDraft).not.toHaveBeenCalled();
  });

  it('update refuses a stale account and writes nothing', async () => {
    const out = await updateMemoAction(prev, formOf({ ...good, memoId: MEMO, draftAccount: 'x' }));
    expect(out.error).toMatch(/account changed/);
    expect(mocks.updateMemo).not.toHaveBeenCalled();
  });
});

describe('Next and Done commit the memo and clear its working copy', () => {
  it('create: one memo, then the new-memo draft is deleted at the revision the form saw, then the saved memo', async () => {
    await expect(createMemoAction(prev, formOf(good))).rejects.toThrow(`REDIRECT /memos/${MEMO}`);
    expect(mocks.createMemo).toHaveBeenCalledTimes(1);
    expect(mocks.tombstoneDraft).toHaveBeenCalledWith(
      { orgId: 'org-1', sub: 'user-1' },
      null,
      'AAAAAAAAAAAA',
    );
  });

  it("update: that memo's draft is deleted, and the form is told where to go (it stays mounted on this page)", async () => {
    const out = await updateMemoAction(prev, formOf({ ...good, memoId: MEMO }));
    expect(out.savedTo).toBe(`/memos/${MEMO}?saved=1`);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.tombstoneDraft).toHaveBeenCalledWith(
      { orgId: 'org-1', sub: 'user-1' },
      MEMO,
      'AAAAAAAAAAAA',
    );
  });

  it('keeps a newer draft from another tab when Next saves the current form', async () => {
    mocks.tombstoneDraft.mockResolvedValueOnce({
      ok: false,
      current: { revision: 'NEWERREVISN', values: {} },
    });
    await expect(createMemoAction(prev, formOf(good))).rejects.toThrow('REDIRECT');
    expect(mocks.tombstoneDraft).toHaveBeenCalledTimes(1);
  });

  it('a draft store outage never undoes or blocks the memo', async () => {
    mocks.tombstoneDraft.mockRejectedValue(new Error('valkey down'));
    await expect(createMemoAction(prev, formOf(good))).rejects.toThrow(`REDIRECT /memos/${MEMO}`);
  });

  it('a refused create keeps the draft: nothing is deleted', async () => {
    mocks.createMemo.mockRejectedValue(new Error('API said no'));
    const out = await createMemoAction(prev, formOf(good));
    expect(out.error).toBe('API said no');
    expect(mocks.tombstoneDraft).not.toHaveBeenCalled();
  });

  it('a failed validation keeps the draft and the typed values', async () => {
    const out = await createMemoAction(prev, formOf({ ...good, title: '' }));
    expect(out.fieldErrors.title).toBeTruthy();
    expect(out.values.body).toBe('text');
    expect(mocks.createMemo).not.toHaveBeenCalled();
    expect(mocks.tombstoneDraft).not.toHaveBeenCalled();
  });
});

describe('submitting approves the saved memo, so unreviewed working changes stop it', () => {
  const form = () => formOf({ memoId: MEMO, expectedVersion: '1' });

  it('refuses while a working copy with changes exists, and submits nothing', async () => {
    mocks.readDraft.mockResolvedValue({
      revision: 'r',
      values: { title: 'edited', body: '', amount: '1', currency: 'NPR' },
      updatedAt: null,
    });
    expect(await submitMemoAction({}, form())).toEqual({
      error: 'Review your changes before submitting.',
    });
    expect(mocks.submitMemo).not.toHaveBeenCalled();
    expect(mocks.readDraft).toHaveBeenCalledWith({ orgId: 'org-1', sub: 'user-1' }, MEMO);
  });

  it('proceeds when there is no working copy, or it was deleted', async () => {
    mocks.submitMemo.mockResolvedValue({ status: 'pending' });
    await expect(submitMemoAction({}, form())).rejects.toThrow(
      `REDIRECT /memos/${MEMO}?submitted=pending`,
    );
    mocks.readDraft.mockResolvedValue({ revision: 'T', values: null, updatedAt: null });
    await expect(submitMemoAction({}, form())).rejects.toThrow('REDIRECT');
  });

  it('refuses when the draft store cannot answer: unknown is not the same as no changes', async () => {
    mocks.readDraft.mockRejectedValue(new Error('valkey down'));
    const out = await submitMemoAction({}, form());
    expect(out.error).toMatch(/could not be checked/);
    expect(mocks.submitMemo).not.toHaveBeenCalled();
  });
});
