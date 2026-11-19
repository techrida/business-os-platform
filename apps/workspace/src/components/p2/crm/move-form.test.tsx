// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MoveForm } from './move-form';
import { userMoves } from './stages';

const LEAD = '11111111-1111-4111-8111-111111111111';
/** The lead page's header owns Qualify and Mark lost, and Convert has its own card. */
const HEADER_OWNED = ['qualified', 'lost', 'converted'] as const;
const action = vi.fn(() => Promise.resolve({}));

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

/** The stage values the Select offers, read by opening it the way a person does. */
async function offeredStages(container: HTMLElement): Promise<string[]> {
  const field = container.querySelector('input[type="hidden"][name="stage"]');
  await click(field?.parentElement?.querySelector('button') ?? null);
  return [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? '');
}

function mount(stage: string, exclude?: readonly string[]) {
  return mountForm(
    <MoveForm
      action={action}
      recordId={LEAD}
      version={3}
      moves={userMoves('lead', stage)}
      exclude={exclude}
      emptyText="No further moves from here."
    />,
  );
}

it('drops the header-owned targets and keeps the rest of the moves from Contacted', async () => {
  const mounted = await mount('contacted', HEADER_OWNED);
  const stage = mounted.container.querySelector<HTMLInputElement>('input[name="stage"]');
  expect(stage?.value).toBe('on_hold');
  expect(await offeredStages(mounted.container)).toEqual(['On Hold (needs a reason)']);
  await mounted.unmount();
});

it('keeps every move when nothing is excluded, as the board and opportunities need', async () => {
  const mounted = await mount('contacted');
  expect(await offeredStages(mounted.container)).toEqual([
    'Qualified',
    'Lost (needs a reason)',
    'On Hold (needs a reason)',
  ]);
  await mounted.unmount();
});

it('offers Contacted and On Hold from New once Lost moves to the header', async () => {
  const mounted = await mount('new', HEADER_OWNED);
  expect(await offeredStages(mounted.container)).toEqual(['Contacted', 'On Hold (needs a reason)']);
  await mounted.unmount();
});

it('shows the empty text instead of a form when only header-owned moves remain', async () => {
  const mounted = await mountForm(
    <MoveForm
      action={action}
      recordId={LEAD}
      version={3}
      moves={[
        { stage: 'qualified', label: 'Qualified', needsReason: false },
        { stage: 'lost', label: 'Lost', needsReason: true },
      ]}
      exclude={HEADER_OWNED}
      emptyText="No further moves from here."
    />,
  );
  expect(mounted.container.querySelector('form')).toBeNull();
  expect(mounted.container.textContent).toBe('No further moves from here.');
  await mounted.unmount();
});
