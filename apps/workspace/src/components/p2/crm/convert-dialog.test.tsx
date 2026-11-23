// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { act } from 'react';

import { choose, click, fill, mountForm, submit, typeKeys } from '@/test/form-interactions';
import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const api = vi.hoisted(() => ({
  convertLead: vi.fn(),
  listContacts: vi.fn(),
  listCustomers: vi.fn(),
}));
vi.mock('./crm-api', () => ({ convertLead: api.convertLead }));
vi.mock('@/components/p2/customers/api', () => ({
  listContacts: api.listContacts,
  listCustomers: api.listCustomers,
}));

import { convertLeadAction } from '@/app/(app)/leads/actions';
import { searchConversionCustomers } from './record-lookups';
import { ConvertDialog, type ConvertLead } from './convert-dialog';
import type { DuplicateInfo } from './types';

const LEAD = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const NO_MAIL = '44444444-4444-4444-8444-444444444444';
let mounted: Awaited<ReturnType<typeof mountForm>>;
let submitted: FormData[];
beforeEach(() => {
  vi.clearAllMocks();
  submitted = [];
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout: the country list scrolls its active option into view.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error('Conversion dialog is not open');
  return element;
}

/** Types the customer's street address (a textarea) and city. */
async function fillAddress(line: string, city: string) {
  const area = dialog().querySelector('textarea[name="address.line"]');
  if (!(area instanceof HTMLTextAreaElement)) throw new Error('Missing address box');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, line);
  await act(() => Promise.resolve(area.dispatchEvent(new Event('input', { bubbles: true }))));
  await fill(dialog().querySelector('[name="address.city"]'), city);
}

/** Picks a country in the CountrySelect that posts `name`, by typing its name and pressing Enter. */
async function pickCountry(name: string, country: string) {
  const box = dialog()
    .querySelector(`input[type="hidden"][name="${name}"]`)
    ?.parentElement?.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!box) throw new Error(`No country box posting ${name}`);
  await act(() => Promise.resolve(box.select()));
  await typeKeys(box, country);
  await act(() =>
    Promise.resolve(
      box.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    ),
  );
}

async function showDuplicate(duplicate: DuplicateInfo) {
  api.convertLead
    .mockRejectedValueOnce(
      new ApiError(409, 'duplicate', {
        error: { code: 'duplicate_found', duplicates: [duplicate] },
      }),
    )
    .mockRejectedValue(new ApiError(503, 'offline'));
  api.listContacts.mockResolvedValue({
    items: [
      { id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' },
      { id: NO_MAIL, fullName: 'Ravi', email: null },
    ],
  });
  mounted = await mountForm(
    <ConvertDialog
      lead={{
        id: LEAD,
        version: 1,
        number: 'LEAD-1',
        title: 'Office supply',
        companyName: 'Himal Supplies',
        contactName: 'Mina',
        email: '',
        country: 'NP',
        phones: [],
      }}
      action={async (prev, form) => {
        submitted.push(form);
        return convertLeadAction(prev, form);
      }}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await fillAddress('Balaju', 'Kathmandu');
  await fill(dialog().querySelector('[name="contactEmail"]'), 'mina@himal.example');
  await submit(dialog());
  expect(api.convertLead).toHaveBeenCalledTimes(1);
  const useExisting = [...dialog().querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Use existing'),
  );
  await click(useExisting ?? null);
}

it('clicking Use existing on a contact match submits its customer and contact through the real action', async () => {
  await showDuplicate({
    kind: 'contact',
    id: CONTACT,
    customerId: CUSTOMER,
    label: 'Mina',
    matchedOn: 'email',
  });
  await submit(dialog());
  expect(submitted[1]?.get('customerId')).toBe(CUSTOMER);
  expect(submitted[1]?.get('contactId')).toBe(CONTACT);
  expect(api.convertLead).toHaveBeenLastCalledWith(
    expect.anything(),
    LEAD,
    expect.objectContaining({
      customer: { mode: 'existing', customerId: CUSTOMER },
      contact: { mode: 'existing', contactId: CONTACT },
    }),
    expect.stringMatching(/^[0-9a-f-]{36}$/),
  );
});

it("offers the existing customer's contacts, a contact without an email disabled, and submits the chosen one", async () => {
  await showDuplicate({
    kind: 'customer',
    id: CUSTOMER,
    label: 'Himal Supplies',
    matchedOn: 'name',
  });
  expect(api.listContacts).toHaveBeenCalledWith(expect.anything(), CUSTOMER);
  await click(radioFor('Link to an existing contact'));
  const field = dialog().querySelector<HTMLInputElement>('input[name="contactId"]');
  await click(field?.parentElement?.querySelector('button') ?? null);
  const options = Array.from(document.querySelectorAll('[role="option"]'));
  const mina = options.find((o) => o.textContent?.includes('Mina'));
  expect(mina).toBeDefined();
  const ravi = options.find((o) => o.textContent?.includes('Ravi'));
  expect(ravi?.textContent?.trim()).toBe('Ravi (no email address)');
  expect(ravi?.getAttribute('aria-disabled')).toBe('true');
  await click(mina ?? null);
  expect(field?.value).toBe(CONTACT);
  await submit(dialog());
  expect(submitted[1]?.get('contactId')).toBe(CONTACT);
  expect(api.convertLead).toHaveBeenLastCalledWith(
    expect.anything(),
    LEAD,
    expect.objectContaining({
      customer: { mode: 'existing', customerId: CUSTOMER },
      contact: { mode: 'existing', contactId: CONTACT },
    }),
    expect.any(String),
  );
  expect(dialog().textContent).not.toContain(CONTACT);
  expect(dialog().textContent).not.toContain('customer screens');
});

it('searches a different legal name and links the selected customer without duplicate detection', async () => {
  api.convertLead.mockRejectedValue(new ApiError(503, 'offline'));
  api.listCustomers.mockResolvedValue({
    items: [{ id: CUSTOMER, legalName: 'Mountain Legal Ltd', number: 'CUS-0001' }],
  });
  api.listContacts.mockResolvedValue({
    items: [{ id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' }],
  });
  mounted = await mountForm(
    <ConvertDialog
      lead={{
        id: LEAD,
        version: 1,
        number: 'LEAD-1',
        title: 'Office supply',
        companyName: 'Trading Alias',
        contactName: '',
        email: '',
        country: 'NP',
        phones: [],
      }}
      action={async (prev, form) => {
        submitted.push(form);
        return convertLeadAction(prev, form);
      }}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await click(radioFor('Link to an existing organization'));
  await fill(dialog().querySelector('input[maxlength="100"]'), 'Mountain');
  await click(
    [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Search') ?? null,
  );
  expect(api.listCustomers).toHaveBeenLastCalledWith(expect.anything(), {
    q: 'Mountain',
    limit: 20,
  });
  await choose(dialog(), 'customerId', 'Mountain Legal Ltd · CUS-0001');
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
  expect(api.listContacts).toHaveBeenCalledWith(expect.anything(), CUSTOMER);
  await click(radioFor('Link to an existing contact'));
  await choose(dialog(), 'contactId', 'Mina');
  expect(dialog().querySelector<HTMLInputElement>('input[name="contactId"]')?.value).toBe(CONTACT);
  await submit(dialog());
  expect(submitted[0]?.get('customerId')).toBe(CUSTOMER);
  expect(submitted[0]?.getAll('customerMode')).toEqual(['existing']);
  expect(api.convertLead).toHaveBeenCalledTimes(1);
  expect(api.convertLead).toHaveBeenCalledWith(
    expect.anything(),
    LEAD,
    expect.objectContaining({
      customer: { mode: 'existing', customerId: CUSTOMER },
      contact: { mode: 'existing', contactId: CONTACT },
    }),
    expect.any(String),
  );
  expect(dialog().textContent).not.toContain(CUSTOMER);
});

it('keeps refused customer searches empty and does not issue blank or oversized reads', async () => {
  api.listCustomers.mockRejectedValue(new ApiError(403, 'forbidden'));
  const result = await searchConversionCustomers('Mountain');
  expect(result.options).toEqual([]);
  expect(result.error).toBeTruthy();
  api.listCustomers.mockClear();
  expect(await searchConversionCustomers('  ')).toEqual({ options: [], error: '' });
  expect(await searchConversionCustomers('x'.repeat(101))).toEqual({ options: [], error: '' });
  expect(api.listCustomers).not.toHaveBeenCalled();
});

async function mountNewCustomer(lead: Partial<ConvertLead> = {}) {
  api.convertLead.mockRejectedValue(new ApiError(503, 'offline'));
  mounted = await mountForm(
    <ConvertDialog
      lead={{
        id: LEAD,
        version: 1,
        number: 'LEAD-1',
        title: 'Office supply',
        companyName: 'New Supplies',
        contactName: 'Mina',
        email: 'mina@newsupplies.example',
        country: 'NP',
        phones: [],
        ...lead,
      }}
      action={async (prev, form) => {
        submitted.push(form);
        return convertLeadAction(prev, form);
      }}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await fillAddress('Balaju', 'Kathmandu');
}

/** The visible text box of a digit input, found from its posted hidden input. */
/** The design-system radio inside the label with this text (the two groups share the value "existing"). */
function radioFor(text: string): HTMLElement | null {
  const label = [...dialog().querySelectorAll('label')].find((l) => l.textContent?.trim() === text);
  return label?.querySelector<HTMLElement>('button[role="radio"]') ?? null;
}

function digitBox(name: string): HTMLInputElement | null {
  return (
    dialog()
      .querySelector(`input[type="hidden"][name="${name}"]`)
      ?.parentElement?.querySelector<HTMLInputElement>('input[type="text"]') ?? null
  );
}

it('keeps a short new-contact phone blocked after switching to an existing contact and back', async () => {
  await mountNewCustomer();
  const box = dialog().querySelector<HTMLInputElement>('input[aria-label="Phone 1 number"]');
  await fill(box, '981234567');
  await click(radioFor('Link to an existing contact'));
  await click(radioFor('Create a contact from the lead'));
  expect(
    dialog().querySelector<HTMLInputElement>('input[aria-label="Phone 1 number"]')?.value,
  ).toBe('981234567');
  await submit(dialog());
  expect(submitted).toHaveLength(0);
  expect(api.convertLead).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain('A mobile number has 10 digits; this has 9.');
});

it("starts the customer and the contact in the lead's country, with one Country in the address block", async () => {
  await mountNewCustomer({ country: 'IN' });
  expect(dialog().querySelectorAll('[name="address.country"]')).toHaveLength(1);
  expect(dialog().querySelector<HTMLInputElement>('[name="address.country"]')?.value).toBe('IN');
  expect(dialog().querySelector<HTMLInputElement>('[name="contactCountry"]')?.value).toBe('IN');
  expect(dialog().querySelector('[name="country"]')).toBeNull();
  expect(dialog().querySelector('[name="line1"]')).toBeNull();
  expect(dialog().textContent).not.toContain('Country code');
});

it("names the address country and the contact's country apart", async () => {
  await mountNewCustomer({ country: 'IN' });
  const labelFor = (name: string) => {
    const box = dialog().querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    const control = box.parentElement!.querySelector('[role="combobox"]')!;
    return document.getElementById(control.getAttribute('aria-labelledby')!)?.textContent;
  };
  expect(labelFor('address.country')).toBe('Country');
  expect(labelFor('contactCountry')).toBe('Contact country');
  const labels = [...dialog().querySelectorAll('label')].map((label) => label.textContent);
  expect(labels.filter((text) => text === 'Country')).toHaveLength(1);
});

it('converts a foreign lead without a PAN', async () => {
  await mountNewCustomer({ country: 'IN' });
  await fillAddress('Connaught Place', 'New Delhi');
  // A foreign customer gets the loose, optional tax id box, not the nine-digit PAN box.
  expect(digitBox('panVatNo')).toBeNull();
  await submit(dialog());
  expect(api.convertLead).toHaveBeenCalledTimes(1);
  const body: unknown = api.convertLead.mock.calls[0]?.[2];
  expect(body).toMatchObject({
    customer: {
      mode: 'create',
      customer: {
        country: 'IN',
        address: { line: 'Connaught Place', city: 'New Delhi' },
      },
    },
    contact: { mode: 'create', contact: { country: 'IN', phones: [] } },
  });
  expect(body).not.toHaveProperty(['customer', 'customer', 'panVatNo']);
});

it('refuses a Nepal lead with a short PAN', async () => {
  await mountNewCustomer();
  await fill(digitBox('panVatNo'), '12345');
  await submit(dialog());
  expect(submitted).toHaveLength(0);
  expect(api.convertLead).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain('A PAN is 9 digits; this has 5.');
});

it("pre-fills the lead's phones and posts them as given, through a refusal", async () => {
  await mountNewCustomer({
    phones: [
      { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
      { country: 'NP', e164: '+9779812345678', label: null, isPrimary: false },
    ],
  });
  expect(dialog().querySelector<HTMLInputElement>('[name="contactPhones.0.number"]')?.value).toBe(
    '+14155552671',
  );
  expect(dialog().querySelector<HTMLInputElement>('[name="contactPhones.1.country"]')?.value).toBe(
    'NP',
  );
  // An edited number survives the form reset React runs after the refused first try.
  await fill(dialog().querySelector('input[aria-label="Phone 2 number"]'), '9801234567');
  await submit(dialog());
  await submit(dialog());
  expect(api.convertLead).toHaveBeenCalledTimes(2);
  for (const call of api.convertLead.mock.calls) {
    expect(call[2]).toMatchObject({
      contact: {
        mode: 'create',
        contact: {
          country: 'NP',
          phones: [
            { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
            { country: 'NP', e164: '+9779801234567', isPrimary: false },
          ],
        },
      },
    });
  }
});

it('switches a Nepal contact phone row to the United States when +1 4155552671 is typed', async () => {
  await mountNewCustomer();
  const box = () => dialog().querySelector<HTMLInputElement>('input[aria-label="Phone 1 number"]');
  await typeKeys(box(), '+');
  await typeKeys(box(), '1 4155552671');
  await submit(dialog());
  expect(submitted[0]?.get('contactPhones.0.number')).toBe('+14155552671');
  expect(api.convertLead.mock.calls[0]?.[2]).toMatchObject({
    contact: {
      mode: 'create',
      contact: { phones: [{ country: 'US', e164: '+14155552671', isPrimary: true }] },
    },
  });
});

it('flags a short tax id typed for a foreign customer once the country becomes NP', async () => {
  await mountNewCustomer();
  await pickCountry('address.country', 'India');
  expect(dialog().querySelector<HTMLInputElement>('[name="address.country"]')?.value).toBe('IN');
  await fill(dialog().querySelector('[name="panVatNo"]'), '12345');
  await pickCountry('address.country', 'Nepal');
  expect(digitBox('panVatNo')?.value).toBe('12345');
  await submit(dialog());
  expect(submitted).toHaveLength(0);
  expect(api.convertLead).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain('A PAN is 9 digits; this has 5.');
  expect(digitBox('panVatNo')?.getAttribute('aria-invalid')).toBe('true');
});

it('creates a new customer and contact through the real action', async () => {
  api.convertLead.mockRejectedValue(new ApiError(503, 'offline'));
  mounted = await mountForm(
    <ConvertDialog
      lead={{
        id: LEAD,
        version: 1,
        number: 'LEAD-1',
        title: 'Office supply',
        companyName: 'New Supplies',
        contactName: 'Mina',
        email: '',
        country: 'NP',
        phones: [],
      }}
      action={convertLeadAction}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await fillAddress('Balaju', 'Kathmandu');
  // The lead had no email: the contact needs one, so nothing is sent until it is typed.
  await submit(dialog());
  expect(api.convertLead).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain('Quotations are sent to it.');
  const email = dialog().querySelector<HTMLInputElement>('[name="contactEmail"]');
  expect(email?.type).toBe('email');
  expect(email?.required).toBe(true);
  await fill(email, 'mina@newsupplies.example');
  await submit(dialog());
  expect(api.convertLead).toHaveBeenCalledTimes(1);
  expect(api.convertLead.mock.calls[0]?.[1]).toBe(LEAD);
  expect(api.convertLead.mock.calls[0]?.[2]).toMatchObject({
    customer: { mode: 'create', customer: { legalName: 'New Supplies' } },
    contact: {
      mode: 'create',
      contact: { fullName: 'Mina', email: 'mina@newsupplies.example', isPrimary: true },
    },
  });
});
