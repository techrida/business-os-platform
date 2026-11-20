// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type { MemoFormState } from './actions';
import { MemoForm } from './memo-form';
import { MemoReviewGate, useMemoSaveStatus, type MemoSaveStatus } from './memo-review-gate';

const MEMO = '11111111-1111-4111-8111-111111111111';
const seen: MemoSaveStatus[] = [];

function Probe() {
  const status = useMemoSaveStatus();
  if (seen.at(-1) !== status) seen.push(status);
  return null;
}

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  seen.length = 0;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function mountWith(action: (prev: MemoFormState, form: FormData) => Promise<MemoFormState>) {
  mounted = await mountForm(
    <MemoReviewGate>
      <Probe />
      <MemoForm action={action} initial={{ title: 'T', body: 'B' }} memoId={MEMO} memoVersion={2} />
    </MemoReviewGate>,
  );
}

async function settle(fn: () => void = () => {}) {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
}

it('reports a refused Done save as failed, so a waiting Submit is dropped (R2-019)', async () => {
  const reply = deferred<MemoFormState>();
  const action = vi.fn(() => reply.promise);
  await mountWith(action);
  await settle(() => mounted!.container.querySelector('form')!.requestSubmit());
  expect(action).toHaveBeenCalledTimes(1);
  expect(seen).toEqual(['idle', 'saving']);
  await settle(() =>
    reply.resolve({
      values: { title: 'T', body: 'B' },
      fieldErrors: {},
      error: 'This memo changed.',
    }),
  );
  expect(seen).toEqual(['idle', 'saving', 'failed']);
});

it('reports a successful Done save as saved only after the saved page has arrived', async () => {
  const reply = deferred<MemoFormState>();
  await mountWith(vi.fn(() => reply.promise));
  await settle(() => mounted!.container.querySelector('form')!.requestSubmit());
  expect(seen).toEqual(['idle', 'saving']);
  await settle(() =>
    reply.resolve({
      values: { title: 'T', body: 'B' },
      fieldErrors: {},
      savedTo: `/memos/${MEMO}?saved=1`,
    }),
  );
  expect(router.push).toHaveBeenCalledWith(`/memos/${MEMO}?saved=1`);
  // The mocked navigation commits at once; the save turns "saved" only through that navigation, never "failed".
  expect(seen).toEqual(['idle', 'saving', 'saved']);
});
