// @vitest-environment jsdom
// After Verify, Reject or Reverse succeeds, the page drops the button that opened the dialog, so keyboard
// focus must go to the page heading and not fall to <body>.
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

interface State {
  key: string;
  done?: boolean;
  error?: string;
}
const actions = vi.hoisted(() => ({
  verifyAction: vi.fn((prev: State): Promise<State> => Promise.resolve({ ...prev, done: true })),
  rejectAction: vi.fn((prev: State): Promise<State> => Promise.resolve({ ...prev, done: true })),
  reverseAction: vi.fn((prev: State): Promise<State> => Promise.resolve({ ...prev, done: true })),
}));
vi.mock('./review-actions', () => actions);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { ReviewDialogs } = await import('./review-dialogs');

const ALL = { verify: true, reject: true, reverse: true };

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

/** The dialog's own submit button; its label can match the trigger's. */
function submitButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    '[role="dialog"] button[type="submit"], button[type="submit"][form]',
  )!;
}

async function mount() {
  mounted = await mountForm(
    <main>
      <h1>PAY-0001</h1>
      <ReviewDialogs
        paymentId="11111111-1111-4111-8111-111111111111"
        version={1}
        number="RCT-1"
        actions={ALL}
        keys={{ verify: 'key-verify-1', reject: 'key-reject-1', reverse: 'key-reverse-1' }}
      />
    </main>,
  );
}

for (const [trigger, reason] of [
  ['Verify payment', false],
  ['Reject', true],
  ['Reverse payment', true],
] as const) {
  it(`puts focus on the page heading after ${trigger} succeeds, not on the body`, async () => {
    await mount();
    await click(button(trigger));
    await flush();
    if (reason) {
      const box = document.querySelector<HTMLTextAreaElement>('textarea[name="reason"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        box,
        'Wrong amount',
      );
      await act(() => {
        box!.dispatchEvent(new Event('input', { bubbles: true }));
        return Promise.resolve();
      });
    }
    await click(submitButton());
    await flush();
    await flush();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('main h1'));
  });
}

it('keeps focus in the dialog when the action is refused', async () => {
  actions.verifyAction.mockImplementationOnce((prev) =>
    Promise.resolve({ ...prev, error: 'Someone else changed this payment.' }),
  );
  await mount();
  await click(button('Verify payment'));
  await flush();
  await click(submitButton());
  await flush();
  expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
});
