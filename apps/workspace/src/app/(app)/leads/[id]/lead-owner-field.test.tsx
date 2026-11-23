// @vitest-environment jsdom
import { avatarColour, imagePath, type LeadOwnerOption } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { choose, click, fill, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({ updateLead: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/p2/crm/crm-api', () => ({ updateLead: mocks.updateLead }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { LeadOwnerField } from './lead-owner-field';

const LEAD = '11111111-1111-4111-8111-111111111111';
const OWNER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';

const owners: LeadOwnerOption[] = [
  { userId: OWNER, displayName: 'Sita Rai', email: 'sita@example.com' },
  { userId: OTHER, displayName: 'Ram Thapa', email: 'ram@example.com' },
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

/** Let the transition, the mocked call and the state updates finish. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
}

const save = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save owner') ?? null;

function mount(ownerUserId: string | null = OWNER, list: readonly LeadOwnerOption[] = owners) {
  return mountForm(
    <LeadOwnerField
      leadId={LEAD}
      version={6}
      ownerUserId={ownerUserId}
      ownerName={ownerUserId === null ? null : ownerUserId === OWNER ? 'Sita Rai' : 'Kiran Gurung'}
      owners={list}
    />,
  );
}

it('posts the chosen owner with the version the page showed, then toasts', async () => {
  mocks.updateLead.mockResolvedValue({});
  const { container } = await mount();
  expect(container.textContent).toContain('Sita Rai');
  await choose(container, 'ownerUserId', 'Ram Thapa');
  await click(save(container));
  await settle();
  expect(mocks.updateLead).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
    ownerUserId: OTHER,
    expectedVersion: 6,
  });
  expect(mocks.success).toHaveBeenCalledWith('Lead owner changed to Ram Thapa.');
});

it('shows only the owner, with no edit control, when the caller may assign to one person', async () => {
  const { container } = await mount(OWNER, [owners[0]!]);
  expect(container.textContent).toContain('Sita Rai');
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
});

it("shows the owner's picture over the colour seeded from their user id", async () => {
  const pictured = '9f1c2e4a-6b7d-4e8f-a1b2-c3d4e5f60718';
  const picture = '66666666-6666-4666-8666-666666666666';
  // The id must not land on the unseeded colour, or this check would pass without a seed.
  expect(avatarColour(pictured)).not.toBe(avatarColour(null));
  const { container } = await mount(pictured, [
    { ...owners[0]!, userId: pictured, avatarDocumentId: picture },
  ]);
  const avatar = container.querySelector<HTMLElement>('span[aria-hidden="true"]');
  expect(avatar?.style.getPropertyValue('--avatar-fill')).toBe(avatarColour(pictured));
  expect(avatar?.querySelector('img')?.getAttribute('src')).toBe(imagePath(picture));
});

it('offers a reload in the toast when the lead changed underneath the page (409)', async () => {
  mocks.updateLead.mockRejectedValue(
    new ApiError(409, 'stale', {
      error: { code: 'conflict', message: 'stale', correlationId: 'corr-12345678' },
    }),
  );
  const { container } = await mount();
  await choose(container, 'ownerUserId', 'Ram Thapa');
  await click(save(container));
  await settle();
  expect(mocks.error).toHaveBeenCalledOnce();
  const [message, options] = mocks.error.mock.calls[0] as [string, { action?: { label: string } }];
  expect(message).toMatch(/reload/i);
  expect(options.action?.label).toBe('Reload');
  expect(mocks.success).not.toHaveBeenCalled();
});

it('does not post when the owner is unchanged, even if the form is submitted', async () => {
  const { container } = await mount();
  expect(save(container)?.disabled).toBe(true);
  await choose(container, 'ownerUserId', 'Sita Rai');
  await act(() => Promise.resolve(container.querySelector('form')?.requestSubmit()));
  await settle();
  expect(mocks.updateLead).not.toHaveBeenCalled();
});

it('keeps a refusal next to the control', async () => {
  mocks.updateLead.mockRejectedValue(
    new ApiError(403, 'no', {
      error: { code: 'forbidden', message: 'no', correlationId: 'corr-12345678' },
    }),
  );
  const { container } = await mount();
  await choose(container, 'ownerUserId', 'Ram Thapa');
  await click(save(container));
  await settle();
  expect(container.querySelector('[aria-invalid="true"]')).not.toBeNull();
  expect(container.textContent).toMatch(/permission/i);
});

it('names an owner outside the list from the lead and starts on an empty choice', async () => {
  const { container } = await mount(STRANGER);
  expect(container.textContent).toContain('Kiran Gurung');
  expect(container.textContent).not.toContain('unavailable');
  expect(container.querySelector<HTMLInputElement>('input[name="ownerUserId"]')?.value).toBe('');
  expect(save(container)?.disabled).toBe(true);
});

it('words an assignment-rule refusal from its code, next to the control (F1-Q51)', async () => {
  mocks.updateLead.mockRejectedValue(
    new ApiError(400, 'refused', {
      error: {
        code: 'bad_request',
        message: 'ownerUserId cannot be someone more senior than you',
        correlationId: 'corr-12345678',
        details: { assignmentReason: 'upward' },
      },
    }),
  );
  const { container } = await mount();
  await choose(container, 'ownerUserId', 'Ram Thapa');
  await click(save(container));
  await settle();
  expect(container.textContent).toContain('The new owner cannot be someone more senior than you.');
  expect(container.textContent).not.toContain('ownerUserId');
  expect(mocks.error).toHaveBeenCalledWith('The new owner cannot be someone more senior than you.');
});

it('shows the owner choice as name and role, and filters by what is typed (BOS-UI-001)', async () => {
  const { container } = await mount(OWNER, [
    { ...owners[0]!, role: 'Head · Sales' },
    { ...owners[1]!, role: 'Accountant' },
  ]);
  const box = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  expect(box.value).toBe('Sita Rai Head · Sales');
  await fill(box, 'acc');
  const rows = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  expect(rows).toEqual(['Ram ThapaAccountant']);
});
