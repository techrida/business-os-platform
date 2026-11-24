// @vitest-environment jsdom
// Clearing the "Send to" box clears the chosen contact: Send is then refused with "Choose who should receive it."
// and nothing is posted. Real SendDialog, ContactPicker, Combobox and send action; only the API call is faked.
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm, settle } from '@/test/form-interactions';

import { SendDialog } from './send-dialog';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));

// Open the real dialog and render its portal inline.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} defaultOpen />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});

const Q = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const ADA = '44444444-4444-4444-8444-444444444441';
const BOB = '44444444-4444-4444-8444-444444444442';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mocks.requireStaffSession.mockResolvedValue({});
  mocks.apiFetch.mockResolvedValue({ ok: true });
});
afterEach(() => {
  document.body.innerHTML = '';
});

const box = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const chosen = () =>
  document.querySelector<HTMLInputElement>('input[type="hidden"][name="recipientContactId"]')!;
const sendButton = () =>
  Array.from(document.querySelectorAll('footer button')).find(
    (b) => b.textContent?.trim() === 'Send to customer',
  ) ?? null;

async function mountDialog() {
  return mountForm(
    <SendDialog
      quotationId={Q}
      versionId={V}
      version={3}
      number="Q-0007"
      contacts={[
        { id: ADA, name: 'Ada Lovelace', email: 'ada@example.com' },
        { id: BOB, name: 'Bob Builder', email: 'bob@example.com' },
      ]}
      defaultContactId={ADA}
      idempotencyKey={KEY}
      reloadHref={`/quotations/${Q}`}
      blocker={null}
    />,
  );
}

it('refuses to send once the "Send to" box is cleared, and posts nothing', async () => {
  const mounted = await mountDialog();
  expect(chosen().value).toBe(ADA);

  await fill(box(), '');
  await settle();
  expect(chosen().value).toBe('');

  await click(sendButton());
  await settle();

  expect(document.body.textContent).toContain('Choose who should receive it.');
  expect(mocks.apiFetch).not.toHaveBeenCalled();
  await mounted.unmount();
});

it('sends to the contact picked after clearing the box', async () => {
  const mounted = await mountDialog();
  await fill(box(), '');
  await fill(box(), 'bob');
  await click(
    Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
      o.textContent?.includes('Bob Builder'),
    ) ?? null,
  );
  expect(chosen().value).toBe(BOB);

  await click(sendButton());
  await settle();

  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse((mocks.apiFetch.mock.calls[0]![2] as { body: string }).body) as {
    recipientContactId: string;
  };
  expect(body.recipientContactId).toBe(BOB);
  await mounted.unmount();
});
