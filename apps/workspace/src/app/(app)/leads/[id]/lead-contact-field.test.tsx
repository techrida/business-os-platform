// @vitest-environment jsdom
import { formatPartyPhoneForPrint, type PartyPhoneInput } from '@bos/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseLeadUpdate } from '@/components/p2/crm/forms';
import { ApiError } from '@/lib/api';
import { click, typeKeys } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({ updateLead: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/p2/crm/crm-api', () => ({ updateLead: mocks.updateLead }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { LeadContactField, type LeadContactFieldProps } from './lead-contact-field';

const LEAD = '11111111-1111-4111-8111-111111111111';
const NEPAL: PartyPhoneInput = { country: 'NP', e164: '+9779812345678', isPrimary: true };
const US: PartyPhoneInput = { country: 'US', e164: '+14155552671', isPrimary: true };
const NO_WAY = 'A lead needs an email or at least one phone number';

let root: Root | undefined;
let container: HTMLElement;

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
  // jsdom has no layout; the country list scrolls its active option into view.
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => Promise.resolve(root?.unmount()));
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** Let the transition, the mocked call and the state updates finish. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
}

async function show(over: Partial<LeadContactFieldProps> = {}) {
  const props: LeadContactFieldProps = {
    leadId: LEAD,
    version: 4,
    country: 'NP',
    phones: [NEPAL],
    editable: true,
    ...over,
  };
  await act(() => Promise.resolve(root!.render(<LeadContactField {...props} />)));
}

const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;
const numberBox = (n: number) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="Phone ${n} number"]`);
const countryBox = () => {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent === 'Country');
  return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : null;
};

async function pickCountry(box: HTMLInputElement, search: string) {
  await act(() => Promise.resolve(box.focus()));
  await act(() => Promise.resolve(box.select()));
  await typeKeys(box, search);
  await act(() =>
    Promise.resolve(
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    ),
  );
}

describe('LeadContactField', () => {
  it('shows the primary number, and no editor for a read-only caller', async () => {
    await show({ phones: [{ ...NEPAL, isPrimary: false }, US], editable: false });
    expect(container.textContent).toBe(formatPartyPhoneForPrint(US.e164));
    expect(button('Edit country and phones')).toBeNull();
  });

  it('opens on Country and the saved numbers, named for screen readers', async () => {
    await show();
    await click(button('Edit country and phones'));
    expect(countryBox()).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="country"]')?.value).toBe('NP');
    expect(numberBox(1)).not.toBeNull();
    expect(container.querySelector('input[aria-label="Phone 1 country"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="phones.0.number"]')?.value).toBe(
      NEPAL.e164,
    );
  });

  it('posts the new country and every phone, with the version the page showed', async () => {
    mocks.updateLead.mockResolvedValue({});
    await show();
    await click(button('Edit country and phones'));
    await pickCountry(countryBox()!, 'United States');
    await click(container.querySelector('button[data-action="add"]'));
    // A + switches the box to international entry; the code then picks the row's country.
    await typeKeys(numberBox(2), '+');
    await typeKeys(numberBox(2), '1 4155552671');
    expect(container.querySelector<HTMLInputElement>('input[name="phones.1.number"]')?.value).toBe(
      '+14155552671',
    );
    await click(button('Save'));
    await settle();
    expect(mocks.updateLead).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
      country: 'US',
      phones: [NEPAL, { country: 'US', e164: '+14155552671', isPrimary: false }],
      expectedVersion: 4,
    });
    expect(mocks.success).toHaveBeenCalledWith('Country and phones saved.');
  });

  it('sends only the country when the numbers did not change', async () => {
    mocks.updateLead.mockResolvedValue({});
    await show();
    await click(button('Edit country and phones'));
    await pickCountry(countryBox()!, 'India');
    await click(button('Save'));
    await settle();
    expect(mocks.updateLead).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
      country: 'IN',
      expectedVersion: 4,
    });
  });

  it("shows the server's refusal when clearing the only number would leave no way to reach the person", async () => {
    mocks.updateLead.mockRejectedValue(
      new ApiError(400, NO_WAY, {
        error: { code: 'bad_request', message: NO_WAY, correlationId: 'corr-12345678' },
      }),
    );
    await show();
    await click(button('Edit country and phones'));
    await click(container.querySelector('button[aria-label="Remove phone 1"]'));
    await click(button('Save'));
    await settle();
    expect(mocks.updateLead).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
      phones: [],
      expectedVersion: 4,
    });
    expect(container.textContent).toContain(NO_WAY);
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining(NO_WAY));
    // The editor stays open on what was typed, so the person can put a number back.
    expect(button('Save')).not.toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('starts again from the saved numbers when the version changes', async () => {
    await show();
    await click(button('Edit country and phones'));
    expect(container.querySelector<HTMLInputElement>('input[name="phones.0.number"]')?.value).toBe(
      NEPAL.e164,
    );
    await show({ version: 5, country: 'US', phones: [US] });
    // The open editor of version 4 is gone; the new one starts closed, from the new record.
    expect(button('Save')).toBeNull();
    expect(container.textContent).toContain(formatPartyPhoneForPrint(US.e164));
    await click(button('Edit country and phones'));
    expect(container.querySelector<HTMLInputElement>('input[name="phones.0.number"]')?.value).toBe(
      US.e164,
    );
    expect(container.querySelector<HTMLInputElement>('input[name="country"]')?.value).toBe('US');
  });

  it('moves focus to Country on open and back to the button on Cancel', async () => {
    await show();
    await click(button('Edit country and phones'));
    expect(document.activeElement).toBe(countryBox());
    await click(button('Cancel'));
    expect(document.activeElement).toBe(button('Edit country and phones'));
  });

  it('keeps an unfinished number on screen and sends nothing', async () => {
    await show();
    await click(button('Edit country and phones'));
    await click(container.querySelector('button[data-action="add"]'));
    await typeKeys(numberBox(2), '98123');
    await click(button('Save'));
    await settle();
    expect(mocks.updateLead).not.toHaveBeenCalled();
    expect(button('Save')).not.toBeNull();
    expect(numberBox(2)?.value).toContain('98123'.slice(0, 2));
    expect(document.activeElement).toBe(numberBox(2));
  });

  it('offers a reload when the lead changed underneath the page', async () => {
    mocks.updateLead.mockRejectedValue(
      new ApiError(409, 'x', {
        error: { code: 'version_conflict', message: 'x', correlationId: 'corr-12345678' },
      }),
    );
    await show();
    await click(button('Edit country and phones'));
    await pickCountry(countryBox()!, 'India');
    await click(button('Save'));
    await settle();
    const [, options] = (mocks.error.mock.calls.at(-1) ?? []) as [
      string,
      { action?: { label: string } }?,
    ];
    expect(options?.action?.label).toBe('Reload');
    expect(button('Save')).not.toBeNull();
  });

  it('sends nothing when nothing changed, and closes', async () => {
    await show();
    await click(button('Edit country and phones'));
    await click(button('Save'));
    await settle();
    expect(mocks.updateLead).not.toHaveBeenCalled();
    expect(button('Edit country and phones')).not.toBeNull();
  });
});

describe('parseLeadUpdate with country and phones', () => {
  const form = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };
  const row = (i: number, number: string, country: string, primary: boolean) => ({
    [`phones.${i}.number`]: number,
    [`phones.${i}.country`]: country,
    [`phones.${i}.label`]: '',
    [`phones.${i}.isPrimary`]: String(primary),
  });

  it('sends a cleared list as [] and never adds the currency default', () => {
    const r = parseLeadUpdate(form({ expectedVersion: '7', ...row(0, '', 'NP', true) }));
    expect(r).toEqual({ ok: true, data: { phones: [], expectedVersion: 7 } });
  });

  it('puts a number the contract refuses under its own row', () => {
    const r = parseLeadUpdate(
      form({
        expectedVersion: '7',
        ...row(0, '+9779812345678', 'NP', true),
        ...row(1, '+97712', 'NP', false),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors['phones.1']).toBeDefined();
      expect(r.fieldErrors['phones.0']).toBeUndefined();
      expect(r.fieldErrors['ownerUserId']).toBeUndefined();
    }
  });
});
