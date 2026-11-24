// @vitest-environment jsdom
import type { AdminUser } from '@bos/contracts';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm as mountRaw } from '@/test/form-interactions';

import { OWN_ACCOUNT, ROW_SLOTS, RowActions, type RowCapabilities } from './row-actions';

vi.mock('server-only', () => ({}));
const actions = vi.hoisted(() => ({
  changeUserStatusAction: vi.fn(),
  sendPasswordResetAction: vi.fn(),
  setRolesAction: vi.fn(),
}));
vi.mock('./actions', () => actions);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.useFakeTimers();
});
let views: { unmount(): Promise<void> }[] = [];
afterEach(async () => {
  for (const view of views) await view.unmount();
  views = [];
  vi.useRealTimers();
  vi.clearAllMocks();
});

const ME = '00000000-0000-4000-9000-0000000000a1';
const IDP = '00000000-0000-4000-8000-000000000001';

const ALL: RowCapabilities = {
  canCheckAccess: true,
  canSendPasswordReset: true,
  canChangeStatus: true,
  meId: ME,
};

function user(over: Partial<AdminUser> & { id: string }): AdminUser {
  return {
    idpOrgId: IDP,
    email: 'asha@example.test',
    displayName: 'Asha',
    status: 'active',
    roles: [],
    department: null,
    createdAt: '2026-11-19T00:00:00.000Z',
    lastActiveAt: null,
    ...over,
  };
}

function render(u: AdminUser, can: RowCapabilities = ALL): string {
  const name = u.displayName ?? 'Unnamed user';
  return renderToStaticMarkup(
    <RowActions user={u} name={name} label={`${name} · ${u.email ?? ''}`} can={can} />,
  );
}

/** The markup of one slot: from its data-slot to the next slot (or the end of the row). */
function slot(html: string, id: string): string {
  const parts = html.split('data-slot="');
  return (parts.find((p) => p.startsWith(`${id}"`)) ?? '').slice(0, 2000);
}

const ids = (html: string) => [...html.matchAll(/data-slot="([a-z]+)"/g)].map((m) => m[1]);

it('an active person with an email shows every action live, each in its own slot', () => {
  const html = render(user({ id: '00000000-0000-4000-9000-0000000000a2' }));
  expect(ids(html)).toEqual([...ROW_SLOTS]);
  expect(html).toContain('aria-label="Change Asha picture"');
  expect(html).toContain('aria-label="Edit roles for Asha · asha@example.test"');
  expect(html).toContain('aria-label="Check access for Asha · asha@example.test"');
  expect(html).toContain('aria-label="Send password reset email to Asha · asha@example.test"');
  expect(html).toContain('aria-label="Lock Asha · asha@example.test"');
  expect(html).toContain('aria-label="Deactivate Asha · asha@example.test"');
  // Keep locked has no slot of its own: it lives in the Unlock dialog of a person locked after failed sign-ins.
  expect(html).not.toContain('Keep locked');
  expect(html).not.toContain('aria-disabled');
});

const MUTED: {
  name: string;
  row: Partial<AdminUser>;
  can?: Partial<RowCapabilities>;
  slot: string;
  reason: string;
  label: string;
}[] = [
  {
    name: 'no email address',
    row: { email: null },
    slot: 'reset',
    reason: 'No email address set for this user',
    label: 'Send password reset email to',
  },
  {
    name: 'an invited person cannot reset a password',
    row: { status: 'invited' },
    slot: 'reset',
    reason: 'This user hasn’t accepted their invitation yet',
    label: 'Send password reset email to',
  },
  {
    name: 'a deactivated person cannot reset a password',
    row: { status: 'inactive' },
    slot: 'reset',
    reason: 'Can’t send a password reset to a deactivated user',
    label: 'Send password reset email to',
  },
  {
    name: 'a deactivated person cannot be locked',
    row: { status: 'inactive' },
    slot: 'lock',
    reason: 'Can’t lock a deactivated user',
    label: 'Lock',
  },
  {
    name: 'an invited person cannot be locked',
    row: { status: 'invited' },
    slot: 'lock',
    reason: 'Can’t lock a user who hasn’t accepted their invitation yet',
    label: 'Lock',
  },
  {
    name: 'an invited person cannot be deactivated',
    row: { status: 'invited' },
    slot: 'toggle',
    reason: 'Can’t deactivate a user who hasn’t accepted their invitation yet',
    label: 'Deactivate',
  },
  {
    name: 'your own row: lock',
    row: { id: ME },
    slot: 'lock',
    reason: OWN_ACCOUNT,
    label: 'Lock',
  },
  {
    name: 'your own row: deactivate',
    row: { id: ME },
    slot: 'toggle',
    reason: OWN_ACCOUNT,
    label: 'Deactivate',
  },
];

it.each(MUTED)('muted: $name', async ({ row, can, slot: id, reason, label }) => {
  const u = user({ id: '00000000-0000-4000-9000-0000000000a9', ...row });
  const html = render(u, { ...ALL, ...can });
  // Same slots as a fully live row: nothing moved.
  expect(ids(html)).toEqual([...ROW_SLOTS]);
  const cell = slot(html, id);
  expect(cell).toContain('aria-disabled="true"');
  expect(cell).toContain(`aria-label="${label} `);
  expect(cell).toContain('(unavailable)');
  // A real button that is not natively disabled (so it takes focus and hover) and is not a link or submit.
  expect(cell).toMatch(/<button type="button"/);
  expect(cell).not.toContain(' disabled');

  // The design-system tooltip shows the reason on keyboard focus, linked with aria-describedby.
  const name = u.displayName ?? 'Unnamed user';
  const view = await mountRaw(
    <RowActions
      user={u}
      name={name}
      label={`${name} · ${u.email ?? ''}`}
      can={{ ...ALL, ...can }}
    />,
  );
  views.push(view);
  const button = view.container.querySelector<HTMLElement>(`[data-slot="${id}"] button`)!;
  expect(button.getAttribute('aria-disabled')).toBe('true');
  await act(async () => {
    button.focus();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(document.activeElement).toBe(button);
  const tip = document.body.querySelector('[role="tooltip"]');
  expect(tip?.textContent).toBe(reason);
  const describedBy = button.getAttribute('aria-describedby');
  expect(describedBy && document.getElementById(describedBy)?.textContent).toContain(reason);

  // A click does nothing: no action runs and nothing navigates.
  await click(button);
  expect(actions.changeUserStatusAction).not.toHaveBeenCalled();
  expect(actions.sendPasswordResetAction).not.toHaveBeenCalled();
});

it('a live action opens its confirmation dialog while a muted one never does', async () => {
  const u = user({ id: '00000000-0000-4000-9000-0000000000a8', email: null });
  const view = await mountRaw(<RowActions user={u} name="Asha" label="Asha" can={ALL} />);
  views.push(view);
  await click(view.container.querySelector('[data-slot="reset"] button'));
  expect(document.body.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
  await click(view.container.querySelector('[data-slot="lock"] button'));
  expect(document.body.querySelector('[role="alertdialog"], [role="dialog"]')).not.toBeNull();
});

it('a locked person has Unlock in the lock slot and no Keep locked button in the row', () => {
  for (const lockReason of ['failed_sign_ins', 'admin'] as const) {
    const html = render(user({ id: '00000000-0000-4000-9000-0000000000a3', lockReason }));
    expect(slot(html, 'lock')).toContain('aria-label="Unlock Asha');
    expect(html).not.toContain('Keep locked');
    expect(html).not.toContain('aria-disabled');
  }
});

async function openUnlock(lockReason: 'failed_sign_ins' | 'admin') {
  const u = user({ id: '00000000-0000-4000-9000-0000000000c1', lockReason });
  const view = await mountRaw(<RowActions user={u} name="Asha" label="Asha" can={ALL} />);
  views.push(view);
  await click(view.container.querySelector('[data-slot="lock"] button'));
  return document.body.querySelector('[role="alertdialog"], [role="dialog"]');
}

const buttonNamed = (root: Element, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;

it('the Unlock dialog of a person locked after failed sign-ins offers Keep locked, which posts the same lock action', async () => {
  actions.changeUserStatusAction.mockResolvedValue({ status: 'ok', message: 'Locked' });
  const dialog = await openUnlock('failed_sign_ins');
  expect(dialog).not.toBeNull();
  const keep = buttonNamed(dialog!, 'Keep locked');
  expect(keep).not.toBeNull();
  expect(dialog!.textContent).toContain('stay locked until someone unlocks them');
  // Focus starts on Cancel, so Enter right after opening confirms nothing.
  expect(document.activeElement?.textContent).toBe('Cancel');
  await click(keep);
  expect(actions.changeUserStatusAction).toHaveBeenCalledExactlyOnceWith(
    '00000000-0000-4000-9000-0000000000c1',
    'lock',
  );
  expect(document.body.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
});

it('while Keep locked is in flight every button is off, so Unlock cannot also be sent', async () => {
  let finish!: (r: { status: 'ok'; message: string }) => void;
  actions.changeUserStatusAction.mockReturnValue(new Promise((r) => (finish = r)));
  const dialog = await openUnlock('failed_sign_ins');
  await click(buttonNamed(dialog!, 'Keep locked'));
  for (const text of ['Cancel', 'Keep locked', 'Unlock']) {
    expect(buttonNamed(dialog!, text)!.disabled).toBe(true);
  }
  await click(buttonNamed(dialog!, 'Unlock'));
  expect(actions.changeUserStatusAction).toHaveBeenCalledTimes(1);
  await act(() => {
    finish({ status: 'ok', message: 'Locked' });
    return Promise.resolve();
  });
  expect(document.body.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
});

it('a failed Keep locked leaves the dialog open and usable', async () => {
  actions.changeUserStatusAction.mockResolvedValue({ status: 'error', message: 'No' });
  const dialog = await openUnlock('failed_sign_ins');
  await click(buttonNamed(dialog!, 'Keep locked'));
  expect(document.body.querySelector('[role="alertdialog"], [role="dialog"]')).not.toBeNull();
  expect(buttonNamed(dialog!, 'Unlock')!.disabled).toBe(false);
});

it('the Unlock dialog still unlocks, and an admin lock offers no Keep locked', async () => {
  actions.changeUserStatusAction.mockResolvedValue({ status: 'ok', message: 'Unlocked' });
  const timed = await openUnlock('failed_sign_ins');
  await click(buttonNamed(timed!, 'Unlock'));
  expect(actions.changeUserStatusAction).toHaveBeenCalledExactlyOnceWith(
    '00000000-0000-4000-9000-0000000000c1',
    'unlock',
  );
  for (const v of views) await v.unmount();
  views = [];
  const admin = await openUnlock('admin');
  expect(admin).not.toBeNull();
  expect(buttonNamed(admin!, 'Keep locked')).toBeNull();
});

it('a deactivated person keeps Deactivate and Reactivate in the same slot', () => {
  const active = render(user({ id: '00000000-0000-4000-9000-0000000000a5' }));
  const inactive = render(user({ id: '00000000-0000-4000-9000-0000000000a6', status: 'inactive' }));
  expect(slot(active, 'toggle')).toContain('aria-label="Deactivate Asha');
  expect(slot(inactive, 'toggle')).toContain('aria-label="Reactivate Asha');
});

it('a role without a permission sees no muted hint for it, but its slot stays reserved', () => {
  const none = render(user({ id: '00000000-0000-4000-9000-0000000000a7' }), {
    canCheckAccess: false,
    canSendPasswordReset: false,
    canChangeStatus: false,
    meId: ME,
  });
  expect(ids(none)).toEqual([...ROW_SLOTS]);
  for (const id of ['access', 'reset', 'lock', 'toggle']) {
    expect(
      slot(none, id).split(`data-slot="${ROW_SLOTS[ROW_SLOTS.indexOf(id as never) + 1]}"`)[0],
    ).toMatch(new RegExp(`^${id}"[^>]*></span>`));
  }
  expect(none).not.toContain('aria-disabled');
});

it('every row of a mixed page has the same slots in the same order', () => {
  const rows = [
    user({ id: ME }),
    user({ id: '00000000-0000-4000-9000-0000000000b1', email: null, status: 'inactive' }),
    user({ id: '00000000-0000-4000-9000-0000000000b2', status: 'invited' }),
    user({ id: '00000000-0000-4000-9000-0000000000b3', lockReason: 'failed_sign_ins' }),
  ].map((u) => ids(render(u)));
  for (const row of rows) expect(row).toEqual([...ROW_SLOTS]);
});
