// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { choose, click, mountForm, submit } from '@/test/form-interactions';

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
    return <Board columns={columns} action={action} noun="opportunity" />;
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
    Promise.resolve({ error: 'You cannot move this opportunity.' }),
  );
  const mounted = await mountForm(<Board columns={before} action={action} noun="opportunity" />);
  try {
    await submit(mounted.container);
    expect(action).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith('You cannot move this opportunity.', {
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

const dragEvent = (type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: vi.fn(), effectAllowed: '' },
  });
  return event;
};

const column = (root: HTMLElement, stage: string) =>
  root.querySelector(`#col-${stage}`)!.closest('section')!;

function dragTo(card: Element, target: Element) {
  act(() => {
    card.dispatchEvent(dragEvent('dragstart'));
  });
  const over = dragEvent('dragover');
  act(() => {
    target.dispatchEvent(over);
  });
  act(() => {
    target.dispatchEvent(dragEvent('drop'));
  });
  return over;
}

const dialog = () => document.querySelector('[role="dialog"]');
const footerButton = (label: string) =>
  [...(dialog()?.querySelectorAll('footer button') ?? [])].find((b) => b.textContent === label) ??
  null;

async function settle() {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
}

const CONTACT_REQUIRED = 'Log a call, email or meeting before moving this lead to Contacted.';

const withHold: BoardColumnData[] = [
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
    ],
  },
  { stage: 'contacted', label: 'Contacted', cards: [] },
  { stage: 'on_hold', label: 'On Hold', cards: [] },
  { stage: 'lost', label: 'Lost', note: 'Mark lost on the record page', cards: [] },
];

it('refuses drops onto the Lost column while a drop onto On Hold opens Move with the stage chosen', async () => {
  const action = vi.fn((): Promise<MoveState> => Promise.resolve({}));
  const mounted = await mountForm(<Board columns={withHold} action={action} noun="lead" />);
  try {
    const card = mounted.container.querySelector('li')!;

    const overLost = dragTo(card, column(mounted.container, 'lost'));
    expect(overLost.defaultPrevented).toBe(false);
    expect(card.querySelector('details')?.open).toBe(false);

    const overHold = dragTo(card, column(mounted.container, 'on_hold'));
    expect(overHold.defaultPrevented).toBe(true);
    expect(card.querySelector('details')?.open).toBe(true);
    expect(card.querySelector<HTMLInputElement>('input[name="stage"]')?.value).toBe('on_hold');
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(card.querySelector('button[aria-haspopup="listbox"]'));
    expect(dialog()).toBeNull();
    expect(action).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});

it('a lead dropped on Contacted opens Mark contacted instead of moving, and Cancel leaves the card', async () => {
  const action = vi.fn((): Promise<MoveState> => Promise.resolve({ ok: true }));
  const mounted = await mountForm(<Board columns={withHold} action={action} noun="lead" />);
  try {
    const card = mounted.container.querySelector('li')!;
    const over = dragTo(card, column(mounted.container, 'contacted'));
    expect(over.defaultPrevented).toBe(true);

    expect(dialog()?.textContent).toContain(
      'LEAD-1 will move from New to Contacted after you log your call, email or meeting.',
    );
    expect(card.querySelector('details')?.open).toBe(false);
    expect(action).not.toHaveBeenCalled();

    await click(footerButton('Cancel'));
    await settle();
    expect(dialog()).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(column(mounted.container, 'new').textContent).toContain(CARD.title);
    expect(column(mounted.container, 'contacted').textContent).not.toContain(CARD.title);
  } finally {
    await mounted.unmount();
  }
});

it('saving Mark contacted after a drop sends the logged contact and the board shows the moved card', async () => {
  const sent: FormData[] = [];
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
    dragTo(mounted.container.querySelector('li')!, column(mounted.container, 'contacted'));
    const note = dialog()?.querySelector('textarea[name="contactBody"]');
    if (!(note instanceof HTMLTextAreaElement)) throw new Error('Missing contactBody');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      note,
      'Called about the enquiry.',
    );
    await act(() => Promise.resolve(note.dispatchEvent(new Event('input', { bubbles: true }))));
    await click(footerButton('Mark contacted'));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.get('recordId')).toBe(CARD.id);
    expect(sent[0]?.get('expectedVersion')).toBe(String(CARD.version));
    expect(sent[0]?.get('stage')).toBe('contacted');
    expect(sent[0]?.get('contactKind')).toBe('call');
    expect(sent[0]?.get('contactBody')).toBe('Called about the enquiry.');
    expect(dialog()).toBeNull();
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith('Moved to Contacted.');
    expect(column(mounted.container, 'contacted').textContent).toContain(CARD.title);
    expect(column(mounted.container, 'new').textContent).not.toContain(CARD.title);
  } finally {
    await mounted.unmount();
  }
});

it('a held lead dropped on Contacted opens Mark contacted naming On Hold as where it moves from', async () => {
  const columns: BoardColumnData[] = [
    { stage: 'contacted', label: 'Contacted', cards: [] },
    {
      stage: 'on_hold',
      label: 'On Hold',
      cards: [{ ...CARD, moves: [{ stage: 'contacted', label: 'Contacted', needsReason: false }] }],
    },
  ];
  const action = vi.fn((): Promise<MoveState> => Promise.resolve({ ok: true }));
  const mounted = await mountForm(<Board columns={columns} action={action} noun="lead" />);
  try {
    dragTo(mounted.container.querySelector('li')!, column(mounted.container, 'contacted'));
    expect(dialog()?.textContent).toContain(
      'LEAD-1 will move from On Hold to Contacted after you log your call, email or meeting.',
    );
    expect(action).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});

it('an opportunity board keeps the Move form for a drop, with no contact dialog', async () => {
  const columns: BoardColumnData[] = [
    {
      stage: 'qualified',
      label: 'Qualified',
      cards: [{ ...CARD, moves: [{ stage: 'contacted', label: 'Contacted', needsReason: false }] }],
    },
    { stage: 'contacted', label: 'Contacted', cards: [] },
  ];
  const action = vi.fn((): Promise<MoveState> => Promise.resolve({}));
  const mounted = await mountForm(<Board columns={columns} action={action} noun="opportunity" />);
  try {
    const card = mounted.container.querySelector('li')!;
    dragTo(card, column(mounted.container, 'contacted'));
    expect(dialog()).toBeNull();
    expect(card.querySelector('details')?.open).toBe(true);
    expect(action).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});

async function typeNote(text: string) {
  const note = dialog()?.querySelector('textarea[name="contactBody"]');
  if (!(note instanceof HTMLTextAreaElement)) throw new Error('Missing contactBody');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, text);
  await act(() => Promise.resolve(note.dispatchEvent(new Event('input', { bubbles: true }))));
}

it('a lead Move form with Contacted chosen opens Mark contacted instead of moving, and Cancel leaves the card', async () => {
  const action = vi.fn((): Promise<MoveState> => Promise.resolve({ error: CONTACT_REQUIRED }));
  const mounted = await mountForm(<Board columns={withHold} action={action} noun="lead" />);
  try {
    const card = mounted.container.querySelector('li')!;
    await click(card.querySelector('summary'));
    await submit(card);

    expect(action).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain(
      'LEAD-1 will move from New to Contacted after you log your call, email or meeting.',
    );
    expect(card.querySelector('details')?.open).toBe(false);

    await click(footerButton('Cancel'));
    await settle();
    expect(dialog()).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(column(mounted.container, 'new').textContent).toContain(CARD.title);
    expect(column(mounted.container, 'contacted').textContent).not.toContain(CARD.title);
  } finally {
    await mounted.unmount();
  }
});

it('saving Mark contacted opened from a lead Move form sends the logged contact and the card moves', async () => {
  const sent: FormData[] = [];
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
    expect(sent).toHaveLength(0);
    await typeNote('Emailed the price list.');
    await click(footerButton('Mark contacted'));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.get('recordId')).toBe(CARD.id);
    expect(sent[0]?.get('expectedVersion')).toBe(String(CARD.version));
    expect(sent[0]?.get('stage')).toBe('contacted');
    expect(sent[0]?.get('contactBody')).toBe('Emailed the price list.');
    expect(dialog()).toBeNull();
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith('Moved to Contacted.');
    expect(column(mounted.container, 'contacted').textContent).toContain(CARD.title);
    expect(column(mounted.container, 'new').textContent).not.toContain(CARD.title);
  } finally {
    await mounted.unmount();
  }
});

it('a lead Move form still sends other stages directly', async () => {
  const action = vi.fn((_prev: MoveState, _form: FormData): Promise<MoveState> =>
    Promise.resolve({}),
  );
  const mounted = await mountForm(<Board columns={withHold} action={action} noun="lead" />);
  try {
    const card = mounted.container.querySelector('li')!;
    await click(card.querySelector('summary'));
    await choose(card, 'stage', 'On Hold (needs a reason)');
    await submit(card);
    expect(action).toHaveBeenCalledOnce();
    expect(action.mock.calls[0]?.[1].get('stage')).toBe('on_hold');
    expect(dialog()).toBeNull();
  } finally {
    await mounted.unmount();
  }
});

it('the lead board hint says moving to Contacted asks for a logged contact; the opportunity hint is unchanged', async () => {
  const action = vi.fn((): Promise<MoveState> => Promise.resolve({}));
  const lead = await mountForm(<Board columns={before} action={action} noun="lead" />);
  try {
    const hint = lead.container.querySelector('p')?.textContent ?? '';
    expect(hint).not.toContain('Either way you confirm with Move');
    expect(hint).toContain(
      'Moving a lead to Contacted asks you to log a call, email or meeting first.',
    );
  } finally {
    await lead.unmount();
  }
  const opportunity = await mountForm(
    <Board columns={before} action={action} noun="opportunity" />,
  );
  try {
    expect(opportunity.container.querySelector('p')?.textContent).toBe(
      'Drag a card to a column, or open Move on a card to pick the stage. Either way you confirm with Move.',
    );
  } finally {
    await opportunity.unmount();
  }
});
