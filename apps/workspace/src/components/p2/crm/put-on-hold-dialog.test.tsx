// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { click, fill, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({
  changeLeadStage: vi.fn(),
  changeOpportunityStage: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  changeLeadStage: mocks.changeLeadStage,
  changeOpportunityStage: mocks.changeOpportunityStage,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { moveLeadStageAction } from '@/app/(app)/leads/actions';
import { moveOpportunityStageAction } from '@/app/(app)/opportunities/actions';

import { PutOnHoldDialog } from './put-on-hold-dialog';

const LEAD = '11111111-1111-4111-8111-111111111111';
const OPP = '22222222-2222-4222-8222-222222222222';

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
const inDialog = (selector: string) => dialog()?.querySelector(selector) ?? null;
const footerButton = (label: string) =>
  [...(dialog()?.querySelectorAll('footer button') ?? [])].find((b) => b.textContent === label) ??
  null;

async function settle() {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
}

async function typeNote(value: string) {
  const note = inDialog('textarea[name="note"]');
  if (!(note instanceof HTMLTextAreaElement)) throw new Error('Missing note');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, value);
  await act(() => Promise.resolve(note.dispatchEvent(new Event('input', { bubbles: true }))));
}

describe('PutOnHoldDialog', () => {
  it('validates required reason and note for a lead before calling the API', async () => {
    const mounted = await mountForm(
      <PutOnHoldDialog
        noun="lead"
        action={moveLeadStageAction}
        id={LEAD}
        number="LD-2026-0019"
        version={4}
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      expect(dialog()?.textContent).toContain('Put this lead on hold?');
      expect(dialog()?.textContent).toContain(
        'LD-2026-0019 will move to On Hold. You can resume it later.',
      );

      await click(footerButton('Put on hold'));
      await settle();

      expect(mocks.changeLeadStage).not.toHaveBeenCalled();
      expect(dialog()?.textContent).toContain('Give a reason, up to 200 characters.');
      expect(dialog()?.textContent).toContain('Add a note for the record, up to 2,000 characters.');
    } finally {
      await mounted.unmount();
    }
  });

  it('moves a lead to On Hold with trimmed reason and note and toasts success', async () => {
    mocks.changeLeadStage.mockResolvedValue({});
    const mounted = await mountForm(
      <PutOnHoldDialog
        noun="lead"
        action={moveLeadStageAction}
        id={LEAD}
        number="LD-2026-0019"
        version={4}
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      await fill(inDialog('input[name="reason"]'), '  Waiting on Q2 budget  ');
      await typeNote('  Contact asked us to follow up next quarter.  ');
      await click(footerButton('Put on hold'));
      await settle();

      expect(mocks.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
        expectedVersion: 4,
        stage: 'on_hold',
        reason: 'Waiting on Q2 budget',
        note: 'Contact asked us to follow up next quarter.',
      });
      expect(mocks.success).toHaveBeenCalledWith('Moved to On Hold.');
      expect(dialog()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('uses opportunity copy and offers Reload on 409 while preserving inputs', async () => {
    mocks.changeOpportunityStage.mockRejectedValueOnce(
      new ApiError(409, 'stale', {
        error: { code: 'conflict', message: 'stale', correlationId: 'c' },
      }),
    );
    const mounted = await mountForm(
      <PutOnHoldDialog
        noun="opportunity"
        action={moveOpportunityStageAction}
        id={OPP}
        number="DEAL-0007"
        version={5}
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      expect(dialog()?.textContent).toContain('Put this opportunity on hold?');
      expect(dialog()?.textContent).toContain(
        'DEAL-0007 will move to On Hold. You can resume it later.',
      );

      await fill(inDialog('input[name="reason"]'), 'Procurement pause');
      await typeNote('Awaiting board sign-off.');
      await click(footerButton('Put on hold'));
      await settle();

      expect(mocks.changeOpportunityStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), OPP, {
        expectedVersion: 5,
        stage: 'on_hold',
        reason: 'Procurement pause',
        note: 'Awaiting board sign-off.',
      });
      expect(mocks.success).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledOnce();
      const options = mocks.error.mock.calls[0]?.[1] as { action?: { label: string } } | undefined;
      expect(options?.action?.label).toBe('Reload');
      expect(dialog()).not.toBeNull();
      expect((inDialog('input[name="reason"]') as HTMLInputElement).value).toBe(
        'Procurement pause',
      );
      expect((inDialog('textarea[name="note"]') as HTMLTextAreaElement).value).toBe(
        'Awaiting board sign-off.',
      );
    } finally {
      await mounted.unmount();
    }
  });
});
