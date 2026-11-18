// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({
  changeLeadStage: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({ changeLeadStage: mocks.changeLeadStage }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { QualifyLead } from './qualify-lead';

const LEAD = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

function dialogButton(label: string) {
  return (
    [...document.querySelectorAll('[role="dialog"] button')].find(
      (button) => button.textContent === label,
    ) ?? null
  );
}

it('only qualifies after confirmation and sends the visible lead version to the stage action', async () => {
  const mounted = await mountForm(<QualifyLead id={LEAD} number="LEAD-1" version={7} />);
  try {
    const trigger = mounted.container.querySelector('button');
    await click(trigger);
    await click(dialogButton('Cancel'));
    expect(mocks.changeLeadStage).not.toHaveBeenCalled();

    await click(trigger);
    await click(dialogButton('Qualify lead'));
    expect(mocks.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
      expectedVersion: 7,
      stage: 'qualified',
    });
    expect(mocks.success).toHaveBeenCalledWith('Moved to Qualified.');
  } finally {
    await mounted.unmount();
  }
});
