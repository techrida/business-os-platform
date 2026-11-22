// @vitest-environment jsdom
import type { LeadLostReason } from '@bos/contracts';
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

import { MarkLostDialog } from './mark-lost-dialog';

const LEAD = '11111111-1111-4111-8111-111111111111';
const reason = (n: number, label: string): LeadLostReason => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  label,
  position: n,
  isDefault: true,
  retired: false,
  version: 1,
});
// The tenant's order, which is not alphabetical: Price comes before Chose a competitor.
const REASONS = [reason(0, 'Price'), reason(1, 'Chose a competitor'), reason(2, 'No budget')];

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
  Element.prototype.scrollIntoView = vi.fn();
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
const combo = () => inDialog('input[role="combobox"]');
const optionTexts = () =>
  [...(dialog()?.querySelectorAll('[role="option"]') ?? [])].map((o) => o.textContent?.trim());

/** Let the transition, the mocked call and the state updates finish. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
}

async function typeNote(value: string) {
  const note = inDialog('textarea[name="note"]');
  if (!(note instanceof HTMLTextAreaElement)) throw new Error('Missing note');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, value);
  await act(() => Promise.resolve(note.dispatchEvent(new Event('input', { bubbles: true }))));
}

/** Types into the Reason box and clicks the option whose text starts with `label`. */
async function pickReason(typed: string, label: string) {
  await fill(combo(), typed);
  const option = [...(dialog()?.querySelectorAll('[role="option"]') ?? [])].find((o) =>
    o.textContent?.trim().startsWith(label),
  );
  if (!option) throw new Error(`No option "${label}"; have ${JSON.stringify(optionTexts())}`);
  await click(option);
}

async function open(reasons: readonly LeadLostReason[] = REASONS) {
  const mounted = await mountForm(
    <MarkLostDialog
      noun="lead"
      action={moveLeadStageAction}
      id={LEAD}
      number="LEAD-1"
      version={4}
      reasons={reasons}
    />,
  );
  const trigger = mounted.container.querySelector('button');
  expect(trigger?.textContent).toBe('Mark lost');
  await click(trigger);
  return mounted;
}

it('promises nothing about reopening a lead it marks lost (U22-Q1)', async () => {
  const mounted = await open();
  try {
    expect(dialog()?.textContent).toContain('LEAD-1 will move to Lost.');
    expect(dialog()?.textContent).not.toContain('quotations');
    expect(dialog()?.textContent).not.toMatch(/reopen|manager/i);
  } finally {
    await mounted.unmount();
  }
});

it('refuses a missing reason and note with field errors and sends nothing', async () => {
  const mounted = await open();
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.changeLeadStage).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('Choose a reason from the list, or add a new one.');
  expect(dialog()?.textContent).toContain('Add a note for the record, up to 2,000 characters.');
  expect(combo()?.getAttribute('aria-invalid')).toBe('true');
  await mounted.unmount();
});

it('refuses a reason without a note', async () => {
  const mounted = await open();
  await pickReason('Pri', 'Price');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.changeLeadStage).not.toHaveBeenCalled();
  expect(dialog()?.textContent).not.toContain('Choose a reason');
  expect(dialog()?.textContent).toContain('Add a note for the record, up to 2,000 characters.');
  await mounted.unmount();
});

it('lists the reasons in the tenant order and filters them as the person types', async () => {
  const mounted = await open();
  await click(combo());
  expect(optionTexts()).toEqual(['Price', 'Chose a competitor', 'No budget']);

  await fill(combo(), 'bud');
  // The one match, then the offer to add the typed words.
  expect(optionTexts()).toEqual(['No budget', 'Add "bud"']);
  await mounted.unmount();
});

it('moves the lead to Lost with the chosen option, the trimmed note and the visible version', async () => {
  mocks.changeLeadStage.mockResolvedValue({});
  const mounted = await open();
  await pickReason('compet', 'Chose a competitor');
  expect((combo() as HTMLInputElement).value).toBe('Chose a competitor');
  await typeNote(' Went with a cheaper local supplier. ');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
    expectedVersion: 4,
    stage: 'lost',
    lostReasonId: REASONS[1]!.id,
    note: 'Went with a cheaper local supplier.',
  });
  expect(mocks.success).toHaveBeenCalledWith('Moved to Lost.');
  expect(dialog()).toBeNull();
  await mounted.unmount();
});

it('adds a typed reason that matches nothing, sending it trimmed as a new option', async () => {
  mocks.changeLeadStage.mockResolvedValue({});
  const mounted = await open();
  await pickReason('  Slow to reply ', 'Add "Slow to reply"');
  expect((combo() as HTMLInputElement).value).toBe('Slow to reply');
  await typeNote('Never answered the follow-ups.');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
    expectedVersion: 4,
    stage: 'lost',
    newLostReason: 'Slow to reply',
    note: 'Never answered the follow-ups.',
  });
  await mounted.unmount();
});

it('does not offer to add words an option already has, whatever the case', async () => {
  const mounted = await open();
  await fill(combo(), ' PRICE ');
  expect(optionTexts()).toEqual(['Price']);
  await mounted.unmount();
});

it('offers only the add row when there are no options yet', async () => {
  const mounted = await open([]);
  await click(combo());
  expect(dialog()?.textContent).toContain('No reasons yet. Type one to add it.');
  await fill(combo(), 'Price');
  expect(optionTexts()).toEqual(['Add "Price"']);
  await mounted.unmount();
});

it('refuses a new reason over 60 characters before any request', async () => {
  const mounted = await open();
  await pickReason('x'.repeat(61), 'Add "');
  await typeNote('Too long a reason.');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.changeLeadStage).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('Keep a new reason to 60 characters or fewer.');
  await mounted.unmount();
});

it('shows the API sentence under the Reason box, for a duplicate added in the meantime', async () => {
  mocks.changeLeadStage.mockRejectedValueOnce(
    new ApiError(409, 'dup', {
      error: {
        code: 'conflict',
        message: '"Slow to reply" is already on the list of lost reasons',
        correlationId: 'c',
      },
    }),
  );
  const mounted = await open();
  await pickReason('Slow to reply', 'Add "Slow to reply"');
  await typeNote('Never answered.');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.error).toHaveBeenCalledOnce();
  expect(dialog()).not.toBeNull();
  expect(dialog()?.textContent).toContain('That reason already exists, or was retired.');
  expect(combo()?.getAttribute('aria-invalid')).toBe('true');
  expect((combo() as HTMLInputElement).value).toBe('Slow to reply');
  await mounted.unmount();
});

it('keeps the dialog and the chosen reason, and offers a reload, when the lead changed meanwhile', async () => {
  mocks.changeLeadStage.mockRejectedValueOnce(
    new ApiError(409, 'stale', { error: { code: 'conflict', message: 'x', correlationId: 'c' } }),
  );
  const mounted = await open();
  await pickReason('Pri', 'Price');
  await typeNote('Went elsewhere.');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledOnce();
  const options = mocks.error.mock.calls[0]?.[1] as { action?: { label: string } } | undefined;
  expect(options?.action?.label).toBe('Reload');
  expect(dialog()).not.toBeNull();
  expect((combo() as HTMLInputElement).value).toBe('Price');
  await mounted.unmount();
});

it('does not blame a typed new reason when the lead changed meanwhile', async () => {
  mocks.changeLeadStage.mockRejectedValueOnce(
    new ApiError(409, 'stale', {
      error: { code: 'conflict', message: 'The lead was changed', correlationId: 'c' },
    }),
  );
  const mounted = await open();
  await pickReason('Slow to reply', 'Add "Slow to reply"');
  await typeNote('Never answered.');
  await click(footerButton('Mark lost'));
  await settle();

  const options = mocks.error.mock.calls[0]?.[1] as { action?: { label: string } } | undefined;
  expect(options?.action?.label).toBe('Reload');
  expect(dialog()?.textContent).not.toContain('That reason already exists');
  expect(combo()?.getAttribute('aria-invalid')).not.toBe('true');
  expect((combo() as HTMLInputElement).value).toBe('Slow to reply');
  await mounted.unmount();
});

it('opens clean after a cancelled attempt', async () => {
  const mounted = await open();
  await pickReason('Pri', 'Price');
  await click(footerButton('Mark lost'));
  await settle();
  expect(dialog()?.textContent).toContain('Add a note');

  await click(footerButton('Cancel'));
  await click(mounted.container.querySelector('button'));
  expect(dialog()?.textContent).not.toContain('Add a note');
  expect((combo() as HTMLInputElement).value).toBe('');
  await mounted.unmount();
});

describe('opportunity noun (D54-3)', () => {
  const OPP = '22222222-2222-4222-8222-222222222222';

  async function openOpportunity(reasons: readonly LeadLostReason[] = REASONS) {
    const mounted = await mountForm(
      <MarkLostDialog
        noun="opportunity"
        action={moveOpportunityStageAction}
        id={OPP}
        number="DEAL-7"
        version={6}
        reasons={reasons}
      />,
    );
    await click(mounted.container.querySelector('button'));
    return mounted;
  }

  it('uses opportunity copy and refuses an empty reason and note before any request', async () => {
    const mounted = await openOpportunity();
    expect(dialog()?.textContent).toContain('Mark this opportunity lost?');
    expect(dialog()?.textContent).toContain(
      'DEAL-7 will move to Lost. Open quotations on this deal will be cancelled.',
    );
    expect(dialog()?.textContent).not.toContain('reopen');
    await click(footerButton('Mark lost'));
    await settle();

    expect(mocks.changeOpportunityStage).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain('Choose a reason from the list, or add a new one.');
    expect(dialog()?.textContent).toContain('Add a note for the record, up to 2,000 characters.');
    await mounted.unmount();
  });

  it('moves the opportunity to Lost with a chosen option from the shared list', async () => {
    mocks.changeOpportunityStage.mockResolvedValue({});
    const mounted = await openOpportunity();
    await pickReason('bud', 'No budget');
    await typeNote(' Budget frozen until Q3. ');
    await click(footerButton('Mark lost'));
    await settle();

    expect(mocks.changeOpportunityStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), OPP, {
      expectedVersion: 6,
      stage: 'lost',
      lostReasonId: REASONS[2]!.id,
      note: 'Budget frozen until Q3.',
    });
    expect(mocks.success).toHaveBeenCalledWith('Moved to Lost.');
    expect(dialog()).toBeNull();
    await mounted.unmount();
  });

  it('adds a typed new reason trimmed when moving an opportunity to Lost', async () => {
    mocks.changeOpportunityStage.mockResolvedValue({});
    const mounted = await openOpportunity();
    await pickReason('  Scope changed  ', 'Add "Scope changed"');
    await typeNote('Client pivoted to an in-house tool.');
    await click(footerButton('Mark lost'));
    await settle();

    expect(mocks.changeOpportunityStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), OPP, {
      expectedVersion: 6,
      stage: 'lost',
      newLostReason: 'Scope changed',
      note: 'Client pivoted to an in-house tool.',
    });
    expect(dialog()).toBeNull();
    await mounted.unmount();
  });

  it('keeps the typed reason and note and offers Reload on a 409 conflict', async () => {
    mocks.changeOpportunityStage.mockRejectedValueOnce(
      new ApiError(409, 'stale', {
        error: { code: 'conflict', message: 'stale', correlationId: 'c' },
      }),
    );
    const mounted = await openOpportunity();
    await pickReason('Scope changed', 'Add "Scope changed"');
    await typeNote('Client pivoted.');
    await click(footerButton('Mark lost'));
    await settle();

    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
    const options = mocks.error.mock.calls[0]?.[1] as { action?: { label: string } } | undefined;
    expect(options?.action?.label).toBe('Reload');
    expect(dialog()).not.toBeNull();
    // A stale record is not a duplicate reason: the Reason field stays valid.
    expect(dialog()?.textContent).not.toContain('That reason already exists');
    expect(combo()?.getAttribute('aria-invalid')).not.toBe('true');
    expect((combo() as HTMLInputElement).value).toBe('Scope changed');
    expect((inDialog('textarea[name="note"]') as HTMLTextAreaElement).value).toBe(
      'Client pivoted.',
    );
    await mounted.unmount();
  });
});
