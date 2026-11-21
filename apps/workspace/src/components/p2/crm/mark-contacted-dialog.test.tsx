// @vitest-environment jsdom
import { act, useState } from 'react';
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
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  changeLeadStage: mocks.changeLeadStage,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { moveLeadStageAction } from '@/app/(app)/leads/actions';

import { MarkContactedDialog } from './mark-contacted-dialog';

const LEAD = '11111111-1111-4111-8111-111111111111';

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

async function typeBody(value: string) {
  const note = inDialog('textarea[name="contactBody"]');
  if (!(note instanceof HTMLTextAreaElement)) throw new Error('Missing contactBody');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, value);
  await act(() => Promise.resolve(note.dispatchEvent(new Event('input', { bubbles: true }))));
}

async function open() {
  const mounted = await mountForm(
    <MarkContactedDialog
      action={moveLeadStageAction}
      id={LEAD}
      number="LD-2026-0019"
      version={3}
    />,
  );
  const trigger = mounted.container.querySelector('button');
  expect(trigger?.textContent).toBe('Mark contacted');
  await click(trigger);
  return mounted;
}

/** A caller that owns `open`, as the board does: its own button opens the dialog. */
function Controlled({
  onOpenChange,
  onMoved,
}: {
  onOpenChange: (open: boolean) => void;
  onMoved: (movedTo: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <span data-testid="opener" onClick={() => setIsOpen(true)} />
      <MarkContactedDialog
        action={moveLeadStageAction}
        id={LEAD}
        number="LD-2026-0019"
        version={3}
        fromLabel="Qualified"
        title="Log the first contact"
        confirmLabel="Save and move"
        open={isOpen}
        onOpenChange={(next) => {
          onOpenChange(next);
          setIsOpen(next);
        }}
        onMoved={onMoved}
      />
    </>
  );
}

async function openControlled() {
  const onOpenChange = vi.fn();
  const onMoved = vi.fn();
  const mounted = await mountForm(<Controlled onOpenChange={onOpenChange} onMoved={onMoved} />);
  const opener = () => mounted.container.querySelector('[data-testid="opener"]');
  await click(opener());
  return { mounted, onOpenChange, onMoved, reopen: () => click(opener()) };
}

describe('MarkContactedDialog', () => {
  it('defaults to Call, validates required note before submit, and sends nothing when blank', async () => {
    const mounted = await open();
    try {
      expect(dialog()?.textContent).toContain('Mark this lead contacted?');
      expect(dialog()?.textContent).toContain(
        'LD-2026-0019 will move from New to Contacted after you log your call, email or meeting.',
      );
      const callRadio = inDialog('button[role="radio"][data-kind="call"]');
      expect(callRadio?.getAttribute('aria-checked')).toBe('true');

      await click(footerButton('Mark contacted'));
      await settle();

      expect(mocks.changeLeadStage).not.toHaveBeenCalled();
      expect(dialog()?.textContent).toContain(
        'Add a note about the call, email or meeting, up to 10,000 characters.',
      );
      expect(inDialog('textarea[name="contactBody"]')?.getAttribute('aria-invalid')).toBe('true');
      // The refusal is announced: focus lands on the field in error, which names its error.
      expect(document.activeElement).toBe(inDialog('textarea[name="contactBody"]'));
    } finally {
      await mounted.unmount();
    }
  });

  it('logs an email with optional subject and moves the lead to Contacted', async () => {
    mocks.changeLeadStage.mockResolvedValue({});
    const mounted = await open();
    try {
      await click(inDialog('button[role="radio"][data-kind="email"]'));
      await fill(inDialog('input[name="contactSubject"]'), '  Intro email  ');
      await typeBody('  Sent brochure and pricing overview.  ');
      await click(footerButton('Mark contacted'));
      await settle();

      expect(mocks.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
        expectedVersion: 3,
        stage: 'contacted',
        contactActivity: {
          kind: 'email',
          subject: 'Intro email',
          body: 'Sent brochure and pricing overview.',
        },
      });
      expect(mocks.success).toHaveBeenCalledWith('Moved to Contacted.');
      expect(dialog()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('omits subject when left blank and submits default Call kind', async () => {
    mocks.changeLeadStage.mockResolvedValue({});
    const mounted = await open();
    try {
      await typeBody('Spoke with Sunita about requirements.');
      await click(footerButton('Mark contacted'));
      await settle();

      expect(mocks.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
        expectedVersion: 3,
        stage: 'contacted',
        contactActivity: {
          kind: 'call',
          body: 'Spoke with Sunita about requirements.',
        },
      });
      expect(mocks.success).toHaveBeenCalledWith('Moved to Contacted.');
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the dialog open with typed text and offers Reload on 409', async () => {
    mocks.changeLeadStage.mockRejectedValueOnce(
      new ApiError(409, 'stale', {
        error: { code: 'conflict', message: 'stale', correlationId: 'c' },
      }),
    );
    const mounted = await open();
    try {
      await typeBody('Called prospect.');
      await click(footerButton('Mark contacted'));
      await settle();

      expect(mocks.success).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledOnce();
      const options = mocks.error.mock.calls[0]?.[1] as { action?: { label: string } } | undefined;
      expect(options?.action?.label).toBe('Reload');
      expect(dialog()).not.toBeNull();
      expect((inDialog('textarea[name="contactBody"]') as HTMLTextAreaElement).value).toBe(
        'Called prospect.',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('opens clean on Call after a cancelled attempt', async () => {
    const mounted = await open();
    try {
      await click(inDialog('button[role="radio"][data-kind="email"]'));
      await click(footerButton('Mark contacted'));
      await settle();
      expect(dialog()?.textContent).toContain('Add a note about the call, email or meeting');

      await click(footerButton('Cancel'));
      await click(mounted.container.querySelector('button'));

      expect(inDialog('button[role="radio"][data-kind="call"]')?.getAttribute('aria-checked')).toBe(
        'true',
      );
      expect(dialog()?.textContent).not.toContain('Add a note about the call, email or meeting');
    } finally {
      await mounted.unmount();
    }
  });

  it('logs a meeting and moves the lead to Contacted', async () => {
    mocks.changeLeadStage.mockResolvedValue({});
    const mounted = await open();
    try {
      await click(inDialog('button[role="radio"][data-kind="meeting"]'));
      await typeBody('Met at the office to walk through the site plan.');
      await click(footerButton('Mark contacted'));
      await settle();

      expect(mocks.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
        expectedVersion: 3,
        stage: 'contacted',
        contactActivity: {
          kind: 'meeting',
          body: 'Met at the office to walk through the site plan.',
        },
      });
      expect(mocks.success).toHaveBeenCalledWith('Moved to Contacted.');
    } finally {
      await mounted.unmount();
    }
  });

  it('renders no trigger when controlled and reports open changes and the move', async () => {
    mocks.changeLeadStage.mockResolvedValue({});
    const { mounted, onOpenChange, onMoved } = await openControlled();
    try {
      expect(mounted.container.querySelector('button')).toBeNull();
      expect(dialog()?.textContent).toContain('Log the first contact');
      expect(dialog()?.textContent).toContain(
        'LD-2026-0019 will move from Qualified to Contacted after you log your call, email or meeting.',
      );

      await typeBody('Called to confirm the visit.');
      await click(footerButton('Save and move'));
      await settle();

      expect(mocks.changeLeadStage).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onMoved).toHaveBeenCalledExactlyOnceWith('Contacted');
      expect(dialog()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('starts clean when reopened by the caller after a cancelled attempt', async () => {
    const { mounted, onOpenChange, onMoved, reopen } = await openControlled();
    try {
      await click(inDialog('button[role="radio"][data-kind="meeting"]'));
      await fill(inDialog('input[name="contactSubject"]'), 'Site visit');
      await click(footerButton('Save and move'));
      await settle();
      expect(dialog()?.textContent).toContain('Add a note about the call, email or meeting');

      await click(footerButton('Cancel'));
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(dialog()).toBeNull();

      await reopen();
      expect(inDialog('button[role="radio"][data-kind="call"]')?.getAttribute('aria-checked')).toBe(
        'true',
      );
      expect((inDialog('input[name="contactSubject"]') as HTMLInputElement).value).toBe('');
      expect(dialog()?.textContent).not.toContain('Add a note about the call, email or meeting');
      expect(mocks.changeLeadStage).not.toHaveBeenCalled();
      expect(onMoved).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
