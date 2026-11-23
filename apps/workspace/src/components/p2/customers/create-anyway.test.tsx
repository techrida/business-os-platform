// @vitest-environment jsdom
import { CustomerDtoSchema, type CustomerDto } from '@bos/contracts';
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { click, mountForm, typeKeys } from '@/test/form-interactions';
import { phoneCountryButton, pickPhoneCountry } from '@/test/phone-field';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: () => Promise.resolve({ roles: ['sales'] }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock('@/lib/grants', () => ({
  getGrants: () => Promise.resolve(new Map([['customer.write', 'all']])),
  hasGrant: (g: Map<string, string>, p: string) => g.has(p),
}));
const api = vi.hoisted(() => ({
  createContact: vi.fn(),
  createCustomer: vi.fn(),
  getCustomer: vi.fn(),
  listCustomers: vi.fn(),
  updateCustomer: vi.fn(),
}));
vi.mock('./api', () => api);

const { createCustomerAction } = await import('./actions');
const { CustomerForm } = await import('./customer-form');
const { EMPTY_CUSTOMER_VALUES } = await import('./forms');

const IDEM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const WHEN = '2026-11-08T05:45:00.000Z';

/** The organization already on file, as `GET /v1/customers` sends it (optional fields omitted). */
const existing: CustomerDto = CustomerDtoSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  number: 'CUS-0007',
  legalName: 'Himalayan Construction Pvt. Ltd.',
  panVatNo: null,
  industry: null,
  relationship: 'active',
  ownerUserId: null,
  defaultCurrency: 'NPR',
  country: 'NP',
  address: { line: 'Balaju', city: 'Kathmandu' },
  mergedIntoId: null,
  version: 1,
  createdAt: WHEN,
  updatedAt: WHEN,
});

/** The API's 400 for a same-name organization without a reason (F1-Q55). */
const reasonRequired = () =>
  new ApiError(400, 'x', {
    error: {
      code: 'bad_request',
      message: 'internal wording',
      correlationId: 'corr-12345678',
      reason: 'duplicate_reason_required',
    },
  });

const initial = {
  ...EMPTY_CUSTOMER_VALUES,
  legalName: 'Himalayan Construction',
  line: 'Balaju',
  city: 'Kathmandu',
  contactName: 'Sita Rai',
  contactEmail: 'sita@himalayan.example',
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout; the country list scrolls its highlighted option into view.
  Element.prototype.scrollIntoView = () => {};
  vi.resetAllMocks();
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

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(() => Promise.resolve());
}

const dialog = () => document.querySelector('[role="dialog"]');
const buttonNamed = (root: ParentNode | null, label: string) =>
  [...(root?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label) ??
  null;

async function typeReason(value: string) {
  const field = dialog()?.querySelector('textarea');
  if (!(field instanceof HTMLTextAreaElement)) throw new Error('Missing reason field');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
  await act(() => Promise.resolve(field.dispatchEvent(new Event('input', { bubbles: true }))));
}

function mount() {
  return mountForm(
    <CustomerForm
      action={createCustomerAction}
      initial={initial}
      mode="create"
      idempotencyKey={IDEM}
      cancelHref="/customers"
      reloadHref="/customers/new"
      enabledCurrencies={['NPR']}
    />,
  );
}

describe('"Create anyway" on a possible duplicate (F1-Q55)', () => {
  it('asks why, refuses a blank reason, then sends the reason with the create', async () => {
    api.listCustomers.mockResolvedValue({ items: [existing], total: 1 });
    // Stop after the create call so the test can read what was sent (a success would redirect).
    api.createCustomer.mockRejectedValue(new ApiError(500, 'down'));
    const mounted = await mount();
    try {
      await act(() => Promise.resolve(mounted.container.querySelector('form')?.requestSubmit()));
      await settle();
      expect(api.createCustomer).not.toHaveBeenCalled();
      expect(mounted.container.textContent).toContain(
        'This may be an organization you already have',
      );

      await click(buttonNamed(mounted.container, 'Create anyway'));
      expect(dialog()?.textContent).toContain('Create anyway?');
      // No reason: refused in the dialog, with the error on the field and focus on it.
      await click(buttonNamed(dialog(), 'Create anyway'));
      await settle();
      expect(api.createCustomer).not.toHaveBeenCalled();
      const field = dialog()?.querySelector('textarea');
      expect(field?.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(field);
      expect(dialog()?.textContent).toContain('Say why this is a different organization');

      await typeReason('  A separate company with the same trading name.  ');
      await click(buttonNamed(dialog(), 'Create anyway'));
      await settle();
      expect(api.createCustomer).toHaveBeenCalledTimes(1);
      expect(api.createCustomer.mock.calls[0]?.[1]).toMatchObject({
        legalName: 'Himalayan Construction',
        duplicateOverrideReason: 'A separate company with the same trading name.',
      });
    } finally {
      await mounted.unmount();
    }
  });

  it('opens the reason dialog when the API refuses a same-name create without a reason', async () => {
    // The search found nothing (say the match was added meanwhile); the API still knows of one.
    api.listCustomers.mockResolvedValue({ items: [], total: 0 });
    api.createCustomer.mockRejectedValueOnce(reasonRequired());
    const mounted = await mount();
    try {
      await act(() => Promise.resolve(mounted.container.querySelector('form')?.requestSubmit()));
      await settle();
      expect(api.createCustomer).toHaveBeenCalledTimes(1);
      expect(api.createCustomer.mock.calls[0]?.[1]).not.toHaveProperty('duplicateOverrideReason');
      // The API asks for a match on the name or on the PAN/VAT number without spaces and hyphens
      // (123-456-789 against 123456789), which the search may not find; the title covers both.
      expect(mounted.container.textContent).toContain(
        'An organization with this name or PAN/VAT number already exists',
      );
      expect(dialog()?.textContent).toContain('Create anyway?');

      api.createCustomer.mockRejectedValueOnce(new ApiError(500, 'down'));
      await typeReason('Different branch, separate PAN pending.');
      await click(buttonNamed(dialog(), 'Create anyway'));
      await settle();
      expect(api.createCustomer).toHaveBeenCalledTimes(2);
      expect(api.createCustomer.mock.calls[1]?.[1]).toMatchObject({
        duplicateOverrideReason: 'Different branch, separate PAN pending.',
      });
      // The refused attempt created nothing, so the retry is a new create with a new key.
      expect(api.createCustomer.mock.calls[1]?.[2]).not.toBe(api.createCustomer.mock.calls[0]?.[2]);
    } finally {
      await mounted.unmount();
    }
  });
});

/** The searchable box of the CountrySelect that posts `name`. */
const countryBox = (root: ParentNode, name: string) =>
  root
    .querySelector(`input[type="hidden"][name="${name}"]`)!
    .parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!;

/** Searches a country box and takes the best match with Enter, as a person does. */
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

const phoneBox = (root: ParentNode, n: number) =>
  root.querySelector<HTMLInputElement>(`input[aria-label="Phone ${n} number"]`)!;

/** Submits, lets the action run, and returns the body the action sent to the API. */
async function submitAndReadBody(container: HTMLElement) {
  await act(() => Promise.resolve(container.querySelector('form')?.requestSubmit()));
  await settle();
  expect(api.createCustomer).toHaveBeenCalledTimes(1);
  return api.createCustomer.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe('the customer form posts the country, address and phone shapes (FX9)', () => {
  beforeEach(() => {
    api.listCustomers.mockResolvedValue({ items: [], total: 0 });
    // Stop after the create call so the test can read what was sent (a success would redirect).
    api.createCustomer.mockRejectedValue(new ApiError(500, 'down'));
  });

  it('sends a number typed as +1 4155552671 into the Nepal row as a US +14155552671', async () => {
    const mounted = await mount();
    try {
      await typeKeys(phoneBox(mounted.container, 1), '+');
      await typeKeys(phoneBox(mounted.container, 1), '1 4155552671');
      const body = await submitAndReadBody(mounted.container);
      expect(body).toMatchObject({
        country: 'NP',
        address: { line: 'Balaju', city: 'Kathmandu' },
        contact: {
          country: 'NP',
          phones: [{ country: 'US', e164: '+14155552671', isPrimary: true }],
        },
      });
    } finally {
      await mounted.unmount();
    }
  });

  it('sends two numbers in different countries, the first one primary', async () => {
    const mounted = await mount();
    try {
      const { container } = mounted;
      await typeKeys(phoneBox(container, 1), '9812345678');
      await click(container.querySelector('button[data-action="add"]'));
      await pickPhoneCountry(phoneCountryButton(container, 2)!, '+1');
      await typeKeys(phoneBox(container, 2), '4155552671');
      const body = await submitAndReadBody(container);
      expect((body.contact as { phones: unknown }).phones).toMatchObject([
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'US', e164: '+14155552671', isPrimary: false },
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it("starts the contact's country from the address country and stops following once it is changed", async () => {
    const mounted = await mount();
    try {
      const { container } = mounted;
      const contactCountry = () =>
        container.querySelector<HTMLInputElement>('input[name="contactCountry"]')!.value;
      await pickCountry(countryBox(container, 'address.country'), 'india');
      expect(contactCountry()).toBe('IN');
      await pickCountry(countryBox(container, 'contactCountry'), 'united states');
      expect(contactCountry()).toBe('US');
      await pickCountry(countryBox(container, 'address.country'), 'nepal');
      expect(contactCountry()).toBe('US');
      const body = await submitAndReadBody(container);
      expect(body).toMatchObject({ country: 'NP', contact: { country: 'US' } });
    } finally {
      await mounted.unmount();
    }
  });

  it('refuses an address that arrives without a country and marks the Country field', async () => {
    const withoutCountry = (prev: Parameters<typeof createCustomerAction>[0], form: FormData) => {
      form.delete('address.country');
      return createCustomerAction(prev, form);
    };
    const mounted = await mountForm(
      <CustomerForm
        action={withoutCountry}
        initial={initial}
        mode="create"
        idempotencyKey={IDEM}
        cancelHref="/customers"
        reloadHref="/customers/new"
        enabledCurrencies={['NPR']}
      />,
    );
    try {
      await act(() => Promise.resolve(mounted.container.querySelector('form')?.requestSubmit()));
      await settle();
      expect(api.createCustomer).not.toHaveBeenCalled();
      const box = countryBox(mounted.container, 'address.country');
      expect(box.getAttribute('aria-invalid')).toBe('true');
      expect(mounted.container.textContent).toContain("Choose the company's country.");
    } finally {
      await mounted.unmount();
    }
  });

  it("shows the server's refusal of a phone under its row and keeps the typed number", async () => {
    // The browser checks each row too; a short number reaching the server is refused the same way.
    const shortNumber = (prev: Parameters<typeof createCustomerAction>[0], form: FormData) => {
      form.set('contactPhones.0.number', '+97798');
      return createCustomerAction(prev, form);
    };
    const mounted = await mountForm(
      <CustomerForm
        action={shortNumber}
        initial={initial}
        mode="create"
        idempotencyKey={IDEM}
        cancelHref="/customers"
        reloadHref="/customers/new"
        enabledCurrencies={['NPR']}
      />,
    );
    try {
      const { container } = mounted;
      await typeKeys(phoneBox(container, 1), '9812345678');
      await act(() => Promise.resolve(container.querySelector('form')?.requestSubmit()));
      await settle();
      expect(api.createCustomer).not.toHaveBeenCalled();
      const box = phoneBox(container, 1);
      expect(box.value).toBe('+977 9812345678');
      const described = (box.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      expect(described).toContain(
        'Enter the whole number with its country code, for example +9779812345678.',
      );
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the typed phone through the duplicate warning and sends it with Create anyway', async () => {
    api.listCustomers.mockResolvedValue({ items: [existing], total: 1 });
    const mounted = await mount();
    try {
      const { container } = mounted;
      await typeKeys(phoneBox(container, 1), '9812345678');
      await act(() => Promise.resolve(container.querySelector('form')?.requestSubmit()));
      await settle();
      expect(container.textContent).toContain('This may be an organization you already have');
      // React resets the form after the action; the list comes back with the number.
      expect(phoneBox(container, 1).value).toBe('+977 9812345678');

      await click(buttonNamed(container, 'Create anyway'));
      await typeReason('A separate company with the same trading name.');
      await click(buttonNamed(dialog(), 'Create anyway'));
      await settle();
      expect(api.createCustomer).toHaveBeenCalledTimes(1);
      expect(api.createCustomer.mock.calls[0]?.[1]).toMatchObject({
        contact: { phones: [{ country: 'NP', e164: '+9779812345678', isPrimary: true }] },
      });
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps a phone typed before the page loaded', async () => {
    const node = (
      <CustomerForm
        action={createCustomerAction}
        initial={initial}
        mode="create"
        idempotencyKey={IDEM}
        cancelHref="/customers"
        reloadHref="/customers/new"
        enabledCurrencies={['NPR']}
      />
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(node);
    document.body.append(container);
    phoneBox(container, 1).value = '9812345678';
    let root: Root | null = null;
    await act(() => {
      root = hydrateRoot(container, node, { onRecoverableError: () => {} });
      return Promise.resolve();
    });
    try {
      expect(
        container.querySelector<HTMLInputElement>('input[name="contactPhones.0.number"]')!.value,
      ).toBe('+9779812345678');
      const body = await submitAndReadBody(container);
      expect(body).toMatchObject({
        contact: { phones: [{ country: 'NP', e164: '+9779812345678', isPrimary: true }] },
      });
    } finally {
      await act(() => Promise.resolve(root!.unmount()));
    }
  });
});
