// @vitest-environment jsdom
import { CreditHoldDtoSchema } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { click, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  overrideCreditHold: vi.fn(),
  revalidatePath: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['finance'] })),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({ overrideCreditHold: mocks.overrideCreditHold }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

const { CreditOverrideDialog } = await import('./credit-override-dialog');

const OPP = '11111111-1111-4111-8111-111111111111';

/** The POST's answer, through the contract. */
const overridden = CreditHoldDtoSchema.parse({
  opportunityId: OPP,
  customerId: '22222222-2222-4222-8222-222222222222',
  currency: 'NPR',
  creditLimit: '500000.00',
  exposure: '512345.50',
  held: true,
  override: {
    reason: 'Paid by cheque today.',
    byUserId: '33333333-3333-4333-8333-333333333333',
    byName: 'Gita Karki',
    at: '2026-11-20T05:45:00.000Z',
  },
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());
}

const dialog = () => document.querySelector('[role="dialog"]');
const footerButton = (label: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label) ?? null;

async function typeReason(value: string) {
  const field = dialog()?.querySelector('textarea');
  if (!(field instanceof HTMLTextAreaElement)) throw new Error('Missing reason field');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
  await act(() => Promise.resolve(field.dispatchEvent(new Event('input', { bubbles: true }))));
}

async function open() {
  const mounted = await mountForm(<CreditOverrideDialog opportunityId={OPP} number="DEAL-0042" />);
  await click(mounted.container.querySelector('button'));
  return mounted;
}

it('refuses a blank reason in the dialog, then sends the trimmed reason and toasts', async () => {
  mocks.overrideCreditHold.mockResolvedValue(overridden);
  const mounted = await open();
  expect(dialog()?.textContent).toContain('Override the credit hold?');
  expect(dialog()?.textContent).toContain('DEAL-0042');

  await click(footerButton('Override hold'));
  await settle();
  expect(mocks.overrideCreditHold).not.toHaveBeenCalled();
  const field = dialog()?.querySelector('textarea');
  expect(field?.getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement).toBe(field);
  expect(dialog()?.textContent).toContain('Say why this deal may go ahead');

  await typeReason('  Paid by cheque today.  ');
  await click(footerButton('Override hold'));
  await settle();
  expect(mocks.overrideCreditHold).toHaveBeenCalledExactlyOnceWith(expect.anything(), OPP, {
    reason: 'Paid by cheque today.',
  });
  expect(mocks.success).toHaveBeenCalledWith(
    'Credit hold overridden. DEAL-0042 can go to a sales order.',
  );
  expect(mocks.revalidatePath).toHaveBeenCalledWith(`/opportunities/${OPP}`);
  expect(dialog()).toBeNull();
  await mounted.unmount();
});

it('offers a reload when the deal is no longer on hold (409)', async () => {
  mocks.overrideCreditHold.mockRejectedValue(
    new ApiError(409, 'conflict', {
      error: { code: 'conflict', message: 'not held', correlationId: 'corr-12345678' },
    }),
  );
  const mounted = await open();
  await typeReason('Customer paid.');
  await click(footerButton('Override hold'));
  await settle();
  const [message, options] = mocks.error.mock.calls[0] as [string, { action?: { label: string } }];
  expect(message).toBe('This opportunity is no longer on credit hold. Reload to see it.');
  expect(options.action?.label).toBe('Reload');
  expect(dialog()).not.toBeNull();
  await mounted.unmount();
});
