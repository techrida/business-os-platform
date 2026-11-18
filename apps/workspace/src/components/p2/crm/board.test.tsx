// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm, submit } from '@/test/form-interactions';

const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { Board } from './board';
import type { BoardColumnData, MoveState } from './types';

const CARD = {
  id: '11111111-1111-4111-8111-111111111111',
  href: '/leads/11111111-1111-4111-8111-111111111111',
  title: 'Website enquiry',
  number: 'LEAD-1',
  subtitle: 'Acme · Ada',
  value: null,
  version: 3,
};

const before: BoardColumnData[] = [
  {
    stage: 'new',
    label: 'New',
    cards: [{ ...CARD, moves: [{ stage: 'contacted', label: 'Contacted', needsReason: false }] }],
  },
  { stage: 'contacted', label: 'Contacted', cards: [] },
];
const after: BoardColumnData[] = [
  { stage: 'new', label: 'New', cards: [] },
  {
    stage: 'contacted',
    label: 'Contacted',
    cards: [{ ...CARD, version: 4, moves: [] }],
  },
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it('announces a successful move even though the card re-renders in its new column', async () => {
  const sent: FormData[] = [];
  // Like a server action with revalidatePath: the refreshed board lands with the action result, so
  // the card's original form unmounts before an effect in it could run.
  function Harness() {
    const [columns, setColumns] = useState(before);
    function action(_prev: MoveState, form: FormData): Promise<MoveState> {
      sent.push(form);
      setColumns(after);
      return Promise.resolve({ ok: true, movedTo: 'Contacted' });
    }
    return <Board columns={columns} action={action} noun="lead" />;
  }

  const mounted = await mountForm(<Harness />);
  try {
    await submit(mounted.container);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.get('recordId')).toBe(CARD.id);
    expect(sent[0]?.get('stage')).toBe('contacted');
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith('Moved to Contacted.', {
      id: `board-move-${CARD.id}`,
    });
    expect(mocks.error).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});

it('toasts a refused move once, from the board only', async () => {
  const action = vi.fn((): Promise<MoveState> =>
    Promise.resolve({ error: 'You cannot move this lead.' }),
  );
  const mounted = await mountForm(<Board columns={before} action={action} noun="lead" />);
  try {
    await submit(mounted.container);
    expect(action).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith('You cannot move this lead.', {
      id: `board-move-${CARD.id}`,
    });
    expect(mocks.success).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});
