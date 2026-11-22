// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  overrideCreditHold: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['finance'] })),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({ overrideCreditHold: mocks.overrideCreditHold }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

const { CreditHoldHelp } = await import('./credit-hold-help');

const OPP = '11111111-1111-4111-8111-111111111111';
const REFUSED = '55555555-5555-4555-8555-555555555555';

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

const dialog = () => document.querySelector('[role="dialog"]');
const footerButton = (label: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label) ?? null;

it('overrides the quotation version the refused confirm named, at the order value shown (R5 FU10)', async () => {
  mocks.overrideCreditHold.mockResolvedValue({});
  const mounted = await mountForm(
    <CreditHoldHelp
      hold={{
        opportunityId: OPP,
        number: 'DEAL-0042',
        canOpen: false,
        canOverride: true,
        quotationVersionId: REFUSED,
        position: {
          orderValue: '90400.00',
          rows: [{ label: 'Total against the limit', value: 'NPR 1,80,800.00' }],
        },
      }}
      selectedVersionId={REFUSED}
      quotationNumber="QT-0007"
    />,
  );
  await click(mounted.container.querySelector('button'));
  const field = dialog()?.querySelector('textarea');
  if (!(field instanceof HTMLTextAreaElement)) throw new Error('Missing reason field');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    field,
    'Advance received.',
  );
  await act(() => Promise.resolve(field.dispatchEvent(new Event('input', { bubbles: true }))));
  await click(footerButton('Override hold'));
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());
  expect(mocks.overrideCreditHold).toHaveBeenCalledExactlyOnceWith(expect.anything(), OPP, {
    reason: 'Advance received.',
    quotationVersionId: REFUSED,
    orderValue: '90400.00',
  });
  await mounted.unmount();
});
