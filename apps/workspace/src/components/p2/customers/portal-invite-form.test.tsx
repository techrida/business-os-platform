// @vitest-environment jsdom
// The invite-portal-admin dialog (F1-Q31): it offers only the customer's existing contacts (no email field, a
// contact without an email cannot be chosen), sends the chosen contact id, and closes with a toast on success.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import type { PortalInviteState } from './form-state';
import { PortalInviteForm } from './portal-invite-form';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const ANA = '33333333-3333-4333-8333-333333333333';
const BIKASH = '44444444-4444-4444-8444-444444444444';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // The shared Select measures its trigger; jsdom has no ResizeObserver.
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it("offers only the customer's contacts, sends the chosen id, and closes with a toast", async () => {
  const action = vi.fn((prev: PortalInviteState, _form: FormData) =>
    Promise.resolve<PortalInviteState>({
      ...prev,
      errors: {},
      saved: 'Portal access granted. An invitation was sent to ana@acme.test.',
      savedCount: prev.savedCount + 1,
    }),
  );
  mounted = await mountForm(
    <PortalInviteForm
      action={action}
      customerId={CUSTOMER}
      idempotencyKey={KEY}
      first
      contacts={[
        {
          id: ANA,
          label: 'Ana Bista (ana@acme.test)',
          name: 'Ana Bista',
          detail: 'Finance head · ana@acme.test',
          hasEmail: true,
        },
        { id: BIKASH, label: 'Bikash Thapa', hasEmail: false },
      ]}
    />,
  );
  const root = mounted.container;

  await click(root.querySelector('[aria-haspopup="dialog"]'));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.textContent).toContain('Invite portal admin');
  // No way to type an address: the admin is always one of the customer's contacts.
  expect(dialog?.querySelector('[name="email"], input[type="email"]')).toBeNull();

  // One box that searches as you type (no Search button); a row shows the name and the email it matched on.
  expect(
    Array.from(dialog!.querySelectorAll('button')).some((b) => /search/i.test(b.textContent ?? '')),
  ).toBe(false);
  await fill(dialog!.querySelector('input[role="combobox"]'), 'ana@acme');
  const rows = Array.from(document.querySelectorAll('[role="option"]'));
  expect(rows.map((r) => r.textContent?.trim())).toEqual([expect.stringContaining('Ana Bista')]);
  expect(rows[0]?.textContent).toContain('ana@acme.test');
  await click(rows[0] ?? null);
  await click(dialog?.querySelector('footer button[type="submit"]') ?? null);

  expect(action).toHaveBeenCalledTimes(1);
  const sent = action.mock.calls[0]![1];
  expect(sent.get('contactId')).toBe(ANA);
  expect(sent.get('customerId')).toBe(CUSTOMER);
  expect(sent.get('idempotencyKey')).toBe(KEY);
  expect(toast.success).toHaveBeenCalledWith(
    'Portal access granted. An invitation was sent to ana@acme.test.',
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('lists a contact without an email but does not let it be chosen', async () => {
  mounted = await mountForm(
    <PortalInviteForm
      action={(prev) => Promise.resolve(prev)}
      customerId={CUSTOMER}
      idempotencyKey={KEY}
      first={false}
      contacts={[{ id: BIKASH, label: 'Bikash Thapa', hasEmail: false }]}
    />,
  );
  await click(mounted.container.querySelector('[aria-haspopup="dialog"]'));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.textContent).toContain('Invite portal user');
  await fill(dialog!.querySelector('input[role="combobox"]'), 'bikash');
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
    el.textContent?.includes('Bikash Thapa'),
  );
  expect(option?.textContent).toContain('No email address');
  expect(option?.getAttribute('aria-disabled')).toBe('true');
  // No create action was given, so there is no Create row.
  expect(document.body.textContent).not.toContain('Create "');
});
