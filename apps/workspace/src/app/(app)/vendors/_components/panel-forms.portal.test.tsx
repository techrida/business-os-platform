// @vitest-environment jsdom
// UIP-FORM-009 on the vendor "Portal access" panel: the Contact field is one search-as-you-type box (no Search
// button, no separate list), each option shows the email, a contact without one cannot be picked, and the last row
// is Create "<typed>", which swaps the form for the add-contact fields with that name filled in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

import type { PanelState } from '../_lib/state';
import { PortalForm, type PortalContactOption } from './panel-forms';

const actions = vi.hoisted(() => ({
  addContactAction: vi.fn(),
  decideBankAction: vi.fn(),
  grantPortalAction: vi.fn(),
  lifecycleAction: vi.fn(),
  proposeBankAction: vi.fn(),
}));

vi.mock('../actions', () => actions);
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const VENDOR = '11111111-1111-4111-8111-111111111111';
const ASHA = '77777777-7777-4777-8777-777777777777';
const BINOD = '88888888-8888-4888-8888-888888888888';
const CONTACTS: PortalContactOption[] = [
  { id: ASHA, label: 'Asha Rai', email: 'asha@himal.example', hasEmail: true },
  { id: BINOD, label: 'Binod Karki', email: null, hasEmail: false },
];

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  actions.grantPortalAction.mockImplementation((prev: PanelState) =>
    Promise.resolve({ ...prev, errors: {} }),
  );
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount() {
  mounted = await mountForm(
    <PortalForm
      vendorId={VENDOR}
      vendorCountry="NP"
      contacts={CONTACTS}
      idempotencyKey="k-1"
      addContactKey="k-2"
    />,
  );
  const container = mounted.container;
  return {
    container,
    box: () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!,
    rows: () => [...document.querySelectorAll('[role="option"]')],
  };
}

describe('vendor portal access contact picker', () => {
  it('searches while typing with no Search button, shows the email, and posts the chosen id', async () => {
    const t = await mount();
    expect(t.container.querySelector('select')).toBeNull();
    expect(t.box().getAttribute('aria-labelledby')).not.toBeNull();
    await fill(t.box(), 'asha');
    expect(t.rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('Asha Raiasha@himal.example'),
      'Create "asha"',
    ]);
    // Nothing was pressed: no button other than the form's own.
    expect([...t.container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Grant portal access',
    ]);
    await click(t.rows()[0]!);
    expect(t.container.querySelector<HTMLInputElement>('input[name="contactId"]')!.value).toBe(
      ASHA,
    );
    await submit(t.container);
    const form = actions.grantPortalAction.mock.calls.at(-1)![1] as FormData;
    expect(form.get('contactId')).toBe(ASHA);
  });

  it('shows a contact without an email as not selectable', async () => {
    const t = await mount();
    await fill(t.box(), 'binod');
    const row = t.rows()[0]!;
    expect(row.textContent).toContain('No email');
    expect(row.getAttribute('aria-disabled')).toBe('true');
  });

  it('offers Create "<typed>" last and opens the add-contact fields with that name filled in', async () => {
    const t = await mount();
    await fill(t.box(), 'Zed Corp');
    // Nothing matches: Create is the only row.
    expect(t.rows().map((r) => r.textContent)).toEqual(['Create "Zed Corp"']);
    await click(t.rows()[0]!);
    expect(t.container.querySelector('input[name="contactId"]')).toBeNull();
    expect(t.container.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe(
      'Zed Corp',
    );
    expect(t.container.querySelector('input[name="email"]')).not.toBeNull();
    expect(t.container.querySelector('input[name="vendorId"]')).not.toBeNull();
    // Cancel goes back to the picker.
    const cancel = [...t.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel',
    );
    await click(cancel ?? null);
    expect(t.box()).not.toBeNull();
  });

  it('comes back to the picker once the new contact is saved', async () => {
    actions.addContactAction.mockImplementation((prev: PanelState) =>
      Promise.resolve({
        ...prev,
        errors: {},
        savedCount: prev.savedCount + 1,
        saved: 'Zed was added.',
      }),
    );
    const t = await mount();
    await fill(t.box(), 'Zed');
    await click(t.rows().at(-1)!);
    await submit(t.container);
    expect(actions.addContactAction).toHaveBeenCalledTimes(1);
    expect(t.box()).not.toBeNull();
  });
});
