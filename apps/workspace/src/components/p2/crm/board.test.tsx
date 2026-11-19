// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm, submit } from '@/test/form-interactions';

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

it('excludes Lost from Move options, hides Move when only Lost was passed, and shows the Lost column note', async () => {
  const onlyLostCard = {
    ...CARD,
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Stalled deal',
    number: 'LEAD-2',
    moves: [{ stage: 'lost', label: 'Lost', needsReason: true }],
  };
  const columns: BoardColumnData[] = [
    {
      stage: 'new',
      label: 'New',
      cards: [
        {
          ...CARD,
          moves: [
            { stage: 'contacted', label: 'Contacted', needsReason: false },
            { stage: 'lost', label: 'Lost', needsReason: true },
            { stage: 'on_hold', label: 'On Hold', needsReason: true },
          ],
        },
        onlyLostCard,
      ],
    },
    { stage: 'contacted', label: 'Contacted', cards: [] },
    { stage: 'lost', label: 'Lost', note: 'Mark lost on the record page', cards: [] },
  ];
  const action = vi.fn((): Promise<MoveState> => Promise.resolve({}));
  const mounted = await mountForm(<Board columns={columns} action={action} noun="lead" />);
  try {
    const lostHeading = mounted.container.querySelector('#col-lost');
    const lostSection = lostHeading?.closest('section');
    expect(lostSection?.textContent).toContain('Mark lost on the record page');

    const cardItems = [...mounted.container.querySelectorAll('li')];
    expect(cardItems).toHaveLength(2);
    expect(cardItems[1]?.getAttribute('draggable')).toBe('false');
    expect(cardItems[1]?.querySelector('details')).toBeNull();

    const firstCard = cardItems[0]!;
    const stageField = firstCard.querySelector('input[type="hidden"][name="stage"]');
    await click(stageField?.parentElement?.querySelector('button') ?? null);
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (o) => o.textContent?.trim() ?? '',
    );
    expect(options).toEqual(['Contacted', 'On Hold (needs a reason)']);
  } finally {
    await mounted.unmount();
  }
});

it('refuses drops onto the Lost column while allowing drops onto valid columns', async () => {
  const columns: BoardColumnData[] = [
    {
      stage: 'new',
      label: 'New',
      cards: [
        {
          ...CARD,
          moves: [
            { stage: 'contacted', label: 'Contacted', needsReason: false },
            { stage: 'lost', label: 'Lost', needsReason: true },
          ],
        },
      ],
    },
    { stage: 'contacted', label: 'Contacted', cards: [] },
    { stage: 'lost', label: 'Lost', note: 'Mark lost on the record page', cards: [] },
  ];
  const action = vi.fn((): Promise<MoveState> => Promise.resolve({}));
  const mounted = await mountForm(<Board columns={columns} action={action} noun="lead" />);
  try {
    const card = mounted.container.querySelector('li')!;
    const lostColumn = mounted.container.querySelector('#col-lost')!.closest('section')!;
    const contactedColumn = mounted.container.querySelector('#col-contacted')!.closest('section')!;

    const dragEvent = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { setData: vi.fn(), effectAllowed: '' },
      });
      return event;
    };

    act(() => {
      card.dispatchEvent(dragEvent('dragstart'));
    });
    const overLost = dragEvent('dragover');
    act(() => {
      lostColumn.dispatchEvent(overLost);
    });
    expect(overLost.defaultPrevented).toBe(false);
    act(() => {
      lostColumn.dispatchEvent(dragEvent('drop'));
    });
    expect(card.querySelector('details')?.open).toBe(false);

    act(() => {
      card.dispatchEvent(dragEvent('dragstart'));
    });
    const overContacted = dragEvent('dragover');
    act(() => {
      contactedColumn.dispatchEvent(overContacted);
    });
    expect(overContacted.defaultPrevented).toBe(true);
    act(() => {
      contactedColumn.dispatchEvent(dragEvent('drop'));
    });
    expect(card.querySelector('details')?.open).toBe(true);
    expect(card.querySelector<HTMLInputElement>('input[name="stage"]')?.value).toBe('contacted');
    expect(action).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});
