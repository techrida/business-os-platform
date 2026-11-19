// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
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

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** Let the confirm promise, the mocked call and the state updates finish. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
}

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
    expect(trigger?.textContent).toBe('Qualify');
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

it('keeps the dialog open and offers a reload when the lead changed meanwhile (409)', async () => {
  mocks.changeLeadStage.mockRejectedValueOnce(
    new ApiError(409, 'stale', { error: { code: 'conflict', message: 'x', correlationId: 'c' } }),
  );
  const mounted = await mountForm(<QualifyLead id={LEAD} number="LEAD-1" version={7} />);
  try {
    await click(mounted.container.querySelector('button'));
    await click(dialogButton('Qualify lead'));
    await settle();

    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
    const options = mocks.error.mock.calls[0]?.[1] as { action?: { label: string } } | undefined;
    expect(options?.action?.label).toBe('Reload');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  } finally {
    await mounted.unmount();
  }
});

it('keeps the dialog open without a reload when the server refuses for another reason', async () => {
  mocks.changeLeadStage.mockRejectedValueOnce(new ApiError(503, 'down'));
  const mounted = await mountForm(<QualifyLead id={LEAD} number="LEAD-1" version={7} />);
  try {
    await click(mounted.container.querySelector('button'));
    await click(dialogButton('Qualify lead'));
    await settle();

    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), undefined);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  } finally {
    await mounted.unmount();
  }
});
