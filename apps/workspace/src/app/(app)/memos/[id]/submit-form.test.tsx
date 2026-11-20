// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const mocks = vi.hoisted(() => ({
  submitMemoAction: vi.fn(),
  toastError: vi.fn<(title: string, options?: { description?: string }) => void>(),
}));
vi.mock('../actions', () => ({ submitMemoAction: mocks.submitMemoAction }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));

import {
  MemoReviewGate,
  UNSAVED_CHANGES_PILL,
  useMemoReviewGate,
  useMemoSaveReporter,
  type MemoSaveStatus,
} from '../memo-review-gate';
import { SubmitForm } from './submit-form';

const MEMO = '11111111-1111-4111-8111-111111111111';

/** Stands in for the edit form: reports what its Done save and its review state are, as the real form does. */
function FakeEditForm({ save, reviewNeeded }: { save: MemoSaveStatus; reviewNeeded: boolean }) {
  const report = useMemoSaveReporter();
  const setReview = useMemoReviewGate();
  useEffect(() => report?.(save), [report, save]);
  useEffect(() => setReview?.(reviewNeeded), [setReview, reviewNeeded]);
  return null;
}

function Page(props: { save: MemoSaveStatus; reviewNeeded?: boolean; version: number }) {
  return (
    <MemoReviewGate>
      <FakeEditForm save={props.save} reviewNeeded={props.reviewNeeded ?? false} />
      <SubmitForm memoId={MEMO} version={props.version} missing={[]} />
    </MemoReviewGate>
  );
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
  mocks.submitMemoAction.mockReset();
  mocks.submitMemoAction.mockResolvedValue({});
  mocks.toastError.mockReset();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

async function confirmSubmit() {
  await click(button(document.body, 'Submit for approval'));
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('The confirm dialog did not open');
  await click(button(dialog, 'Submit for approval'));
}

async function rerender(node: ReactNode) {
  await mounted!.unmount();
  mounted = await mountForm(node);
}

/** A root the test renders into again with new props, as a server re-render does, keeping client state. */
async function live(node: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(() => Promise.resolve(root.render(node)));
  mounted = {
    container,
    async unmount() {
      await act(() => Promise.resolve(root.unmount()));
      container.remove();
    },
  };
  return (next: ReactNode) =>
    act(async () => {
      root.render(next);
      await Promise.resolve();
    });
}

function lastToast(): string {
  return mocks.toastError.mock.calls.at(-1)?.[1]?.description ?? '';
}

it('waits for a Done save in flight and then submits the saved version (R2-019)', async () => {
  const render = await live(<Page save="saving" version={2} />);
  await confirmSubmit();
  expect(mocks.submitMemoAction).not.toHaveBeenCalled();
  expect(button(document.body, 'Submitting')).toBeTruthy();

  // The saved memo arrives (version 3) and the form reports the save as done, in one commit.
  await render(<Page save="saved" version={3} />);
  expect(mocks.submitMemoAction).toHaveBeenCalledTimes(1);
  const sent = mocks.submitMemoAction.mock.calls[0]![1] as FormData;
  expect(sent.get('memoId')).toBe(MEMO);
  expect(sent.get('expectedVersion')).toBe('3');
  expect(mocks.toastError).not.toHaveBeenCalled();
});

it('drops a waiting Submit with a message when the Done save is refused', async () => {
  const render = await live(<Page save="saving" version={2} />);
  await confirmSubmit();
  await render(<Page save="failed" version={2} />);
  expect(mocks.submitMemoAction).not.toHaveBeenCalled();
  expect(mocks.toastError.mock.calls.at(-1)?.[0]).toBe('Not submitted');
  expect(lastToast()).toContain('were not saved');
  expect(button(document.body, 'Submit for approval')).toBeTruthy();
});

it('gives up visibly when the save never reports back', async () => {
  vi.useFakeTimers();
  mounted = await mountForm(<Page save="saving" version={2} />);
  await confirmSubmit();
  await act(async () => {
    vi.advanceTimersByTime(20_000);
    await Promise.resolve();
  });
  expect(mocks.submitMemoAction).not.toHaveBeenCalled();
  expect(mocks.toastError.mock.calls.at(-1)?.[0]).toBe('Not submitted');
  expect(lastToast()).toContain('did not finish');
});

it('submits at once when nothing is being saved', async () => {
  mounted = await mountForm(<Page save="idle" version={4} />);
  await confirmSubmit();
  expect(mocks.submitMemoAction).toHaveBeenCalledTimes(1);
  expect((mocks.submitMemoAction.mock.calls[0]![1] as FormData).get('expectedVersion')).toBe('4');
});

it('names Done in the blocking pill while unsaved edits wait (I-43)', async () => {
  mounted = await mountForm(<Page save="idle" reviewNeeded version={2} />);
  expect(document.body.textContent).toContain(UNSAVED_CHANGES_PILL);
  expect(UNSAVED_CHANGES_PILL).toContain('Done');
  expect(document.body.textContent).not.toContain('Review changes');
  await rerender(<Page save="saving" reviewNeeded version={2} />);
  // While Done saves, the pill steps aside: Submit waits for the save instead.
  expect(document.body.textContent).not.toContain(UNSAVED_CHANGES_PILL);
});
