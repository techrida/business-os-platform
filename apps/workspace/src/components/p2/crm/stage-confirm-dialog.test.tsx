// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { click, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({
  changeOpportunityStage: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  changeOpportunityStage: mocks.changeOpportunityStage,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { moveOpportunityStageAction } from '@/app/(app)/opportunities/actions';

import { StageConfirmDialog } from './stage-confirm-dialog';

const OPP = '22222222-2222-4222-8222-222222222222';

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

describe('StageConfirmDialog', () => {
  it('only moves after confirmation and submits recordId, expectedVersion and stage', async () => {
    mocks.changeOpportunityStage.mockResolvedValue({});
    const mounted = await mountForm(
      <StageConfirmDialog
        action={moveOpportunityStageAction}
        id={OPP}
        version={6}
        stage="requirement_received"
        triggerLabel="Requirement received"
        triggerVariant="primary"
        title="Mark requirement received?"
        description="DEAL-0001 will move from Qualified to Requirement Received."
        confirmLabel="Move to Requirement Received"
        successMessage="Moved to Requirement Received."
      />,
    );
    try {
      const trigger = mounted.container.querySelector('button');
      expect(trigger?.textContent).toBe('Requirement received');

      await click(trigger);
      await click(dialogButton('Cancel'));
      expect(mocks.changeOpportunityStage).not.toHaveBeenCalled();

      await click(trigger);
      await click(dialogButton('Move to Requirement Received'));
      await settle();

      expect(mocks.changeOpportunityStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), OPP, {
        expectedVersion: 6,
        stage: 'requirement_received',
      });
      expect(mocks.success).toHaveBeenCalledWith('Moved to Requirement Received.');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the dialog open and offers Reload on 409', async () => {
    mocks.changeOpportunityStage.mockRejectedValueOnce(
      new ApiError(409, 'stale', {
        error: { code: 'conflict', message: 'stale', correlationId: 'c' },
      }),
    );
    const mounted = await mountForm(
      <StageConfirmDialog
        action={moveOpportunityStageAction}
        id={OPP}
        version={6}
        stage="negotiation"
        triggerLabel="Resume"
        title="Resume this opportunity?"
        description="DEAL-0001 will move from On Hold back to Negotiation."
        confirmLabel="Resume opportunity"
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      await click(dialogButton('Resume opportunity'));
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

  it('keeps the dialog open without a Reload button on other server failures', async () => {
    mocks.changeOpportunityStage.mockRejectedValueOnce(new ApiError(503, 'down'));
    const mounted = await mountForm(
      <StageConfirmDialog
        action={moveOpportunityStageAction}
        id={OPP}
        version={6}
        stage="qualified"
        triggerLabel="Reopen"
        title="Reopen this opportunity?"
        description="DEAL-0001 will move from Lost back to Qualified."
        confirmLabel="Reopen opportunity"
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      await click(dialogButton('Reopen opportunity'));
      await settle();

      expect(mocks.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), undefined);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
