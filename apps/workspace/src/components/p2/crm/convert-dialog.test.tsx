// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { click, fill, mountForm, settle, submit, typeKeys } from '@/test/form-interactions';
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
  api.listCustomers.mockResolvedValue({ items: [], total: 0 });
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

/** Goes through the three steps the way a user does: Next, Next, then Convert. A step that finds a problem stays put. */
async function convert() {
  for (let i = 0; i < 3 && stepOf() !== 'Deal'; i += 1) await submit(dialog());
  if (stepOf() === 'Deal') await submit(dialog());
}

/** Lets a debounced live search (0 ms in these tests) and its server action finish. */
async function flush() {
  await settle();
  await settle();
}

function stepOf(): string | null {
  return (
    dialog()
      .querySelector('[aria-current="step"]')
      ?.textContent?.replace(/^\dStep \d of 3: /, '') ?? null
  );
}

function box(label: string): HTMLInputElement {
  const found = [...dialog().querySelectorAll<HTMLInputElement>('input[role="combobox"]')].find(
    (el) =>
      dialog().querySelector(`[id="${el.getAttribute('aria-labelledby') ?? ''}"]`)?.textContent ===
      label,
  );
  if (!found) throw new Error(`No combobox labelled ${label}`);
  return found;
}

/** The design-system radio for a form field name and value: the button just before Radix's hidden input. */
function radio(name: string, value: string): HTMLElement | null {
  const hidden = dialog().querySelector(`input[name="${name}"][value="${value}"]`);
  const button = hidden?.previousElementSibling;
  return button instanceof HTMLElement ? button : null;
}

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
      searchDelayMs={0}
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
  await convert();
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
  await convert();
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
  await submit(dialog());
  expect(stepOf()).toBe('Contact');
  await flush();
  await click(radio('contactMode', 'existing'));
  const field = dialog().querySelector<HTMLInputElement>('input[name="contactId"]');
  await click(box('Contact'));
  const options = Array.from(document.querySelectorAll('[role="option"]'));
  const mina = options.find((o) => o.textContent?.includes('Mina'));
  expect(mina).toBeDefined();
  const ravi = options.find((o) => o.textContent?.includes('Ravi'));
  expect(ravi?.textContent?.trim()).toBe('Ravi (no email address)');
  expect(ravi?.getAttribute('aria-disabled')).toBe('true');
  await click(mina ?? null);
  expect(field?.value).toBe(CONTACT);
  await convert();
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

it('links an existing organisation through one live-search box: no Find box, no Search button, no second select (UIP-FORM-009)', async () => {
  api.convertLead.mockRejectedValue(new ApiError(503, 'offline'));
  api.listCustomers.mockResolvedValue({
    items: [
      {
        id: CUSTOMER,
        legalName: 'Mountain Legal Ltd',
        number: 'CUS-0001',
        panVatNo: '601234567',
        mergedIntoId: null,
      },
    ],
    total: 1,
  });
  api.listContacts.mockResolvedValue({
    items: [{ id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' }],
  });
  mounted = await mountForm(
    <ConvertDialog
      searchDelayMs={0}
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
  await click(radio('customerMode', 'existing'));
  expect([...dialog().querySelectorAll('button')].some((b) => b.textContent === 'Search')).toBe(
    false,
  );
  expect(dialog().querySelectorAll('[data-step-panel="0"] select')).toHaveLength(0);
  expect(dialog().textContent).not.toContain('Find an organisation');
  await typeKeys(box('Organisation'), 'Mountain');
  await flush();
  expect(api.listCustomers).toHaveBeenLastCalledWith(expect.anything(), {
    q: 'Mountain',
    limit: 20,
  });
  const rows = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  // Name, PAN/VAT and customer number, then the last row Create "<typed>".
  expect(rows).toEqual(['Mountain Legal LtdPAN/VAT 601234567 · CUS-0001', 'Create "Mountain"']);
  await click([...document.querySelectorAll('[role="option"]')][0] ?? null);
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
  expect(api.listContacts).toHaveBeenCalledWith(expect.anything(), CUSTOMER);
  await submit(dialog());
  expect(stepOf()).toBe('Contact');
  await flush();
  await click(radio('contactMode', 'existing'));
  await click(box('Contact'));
  await click(
    [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Mina') ?? null,
  );
  expect(dialog().querySelector<HTMLInputElement>('input[name="contactId"]')?.value).toBe(CONTACT);
  await convert();
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

it('Create "<typed>" is the only row when nothing matches, and choosing it switches to the create form with that name', async () => {
  mounted = await mountForm(
    <ConvertDialog
      searchDelayMs={0}
      lead={{
        id: LEAD,
        version: 1,
        number: 'LEAD-1',
        title: 'Office supply',
        companyName: 'Trading Alias',
        contactName: 'Mina',
        email: 'mina@alias.example',
        country: 'NP',
        phones: [],
      }}
      action={convertLeadAction}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await click(radio('customerMode', 'existing'));
  await typeKeys(box('Organisation'), 'Zed Corp');
  await flush();
  const rows = [...document.querySelectorAll('[role="option"]')];
  expect(rows.map((o) => o.textContent)).toEqual(['Create "Zed Corp"']);
  await click(rows[0] ?? null);
  expect(radio('customerMode', 'create')?.getAttribute('aria-checked') === 'true').toBe(true);
  expect(box('Legal name').value).toBe('Zed Corp');
});

it('starts a lead linked to a customer and contact on converting into them, with no search or duplicate step (R6O)', async () => {
  api.convertLead.mockRejectedValue(new ApiError(503, 'offline'));
  api.listContacts.mockResolvedValue({
    items: [{ id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' }],
  });
  mounted = await mountForm(
    <ConvertDialog
      searchDelayMs={0}
      lead={{
        id: LEAD,
        version: 1,
        number: 'LEAD-1',
        title: 'Office supply',
        companyName: 'Himal Supplies Pvt. Ltd.',
        customerId: CUSTOMER,
        contactId: CONTACT,
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
  // A linked lead has no "new organisation" choice: the mode is fixed to existing.
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerMode"]')?.value).toBe(
    'existing',
  );
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
  expect(dialog().textContent).toContain('Himal Supplies Pvt. Ltd.');
  expect(api.listContacts).toHaveBeenCalledWith(expect.anything(), CUSTOMER);
  await convert();
  expect(api.convertLead).toHaveBeenCalledWith(
    expect.anything(),
    LEAD,
    expect.objectContaining({
      customer: { mode: 'existing', customerId: CUSTOMER },
      contact: { mode: 'existing', contactId: CONTACT },
    }),
    expect.any(String),
  );
});

it('keeps refused customer searches empty and does not issue blank or oversized reads', async () => {
  api.listCustomers.mockRejectedValue(new ApiError(403, 'forbidden'));
  const result = await searchConversionCustomers('Mountain');
  expect(result.customers).toEqual([]);
  expect(result.error).toBeTruthy();
  api.listCustomers.mockClear();
  const none = { customers: [], panMatches: [], error: '' };
  expect(await searchConversionCustomers('  ')).toEqual(none);
  expect(await searchConversionCustomers('x'.repeat(101))).toEqual(none);
  expect(api.listCustomers).not.toHaveBeenCalled();
});

async function mountNewCustomer(lead: Partial<ConvertLead> = {}) {
  api.convertLead.mockRejectedValue(new ApiError(503, 'offline'));
  mounted = await mountForm(
    <ConvertDialog
      searchDelayMs={0}
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
  if (!lead.customerId) await fillAddress('Balaju', 'Kathmandu');
}

/** The visible text box of a digit input, found from its posted hidden input. */
function digitBox(name: string): HTMLInputElement | null {
  return (
    dialog()
      .querySelector(`input[type="hidden"][name="${name}"]`)
      ?.parentElement?.querySelector<HTMLInputElement>('input[type="text"]') ?? null
  );
}

it('keeps a short new-contact phone blocked after switching to an existing contact and back', async () => {
  api.listContacts.mockResolvedValue({
    items: [{ id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' }],
  });
  await mountNewCustomer({ customerId: CUSTOMER });
  await submit(dialog());
  expect(stepOf()).toBe('Contact');
  const phone = () =>
    dialog().querySelector<HTMLInputElement>('input[aria-label="Phone 1 number"]');
  await fill(phone(), '981234567');
  await click(radio('contactMode', 'existing'));
  await click(radio('contactMode', 'create'));
  expect(phone()?.value).toBe('+977 981234567');
  await convert();
  expect(submitted).toHaveLength(0);
  expect(api.convertLead).not.toHaveBeenCalled();
  expect(stepOf()).toBe('Contact');
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
  await convert();
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
  await convert();
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
  await convert();
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
  await convert();
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
  await convert();
  expect(submitted).toHaveLength(0);
  expect(api.convertLead).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain('A PAN is 9 digits; this has 5.');
  expect(digitBox('panVatNo')?.getAttribute('aria-invalid')).toBe('true');
});

it('creates a new customer and contact through the real action', async () => {
  api.convertLead.mockRejectedValue(new ApiError(503, 'offline'));
  mounted = await mountForm(
    <ConvertDialog
      searchDelayMs={0}
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
  await convert();
  expect(api.convertLead).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain('Quotations are sent to it.');
  const email = dialog().querySelector<HTMLInputElement>('[name="contactEmail"]');
  expect(email?.type).toBe('email');
  expect(email?.required).toBe(true);
  await fill(email, 'mina@newsupplies.example');
  await convert();
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

// ---- R6T: the three-step wizard ---------------------------------------------------------------------------------

const PAN_CUSTOMER = {
  id: CUSTOMER,
  legalName: 'Himal Supplies Pvt. Ltd.',
  number: 'CUS-0007',
  panVatNo: '601234567',
  mergedIntoId: null,
};

it('goes Organisation, Contact, Deal with Back and Next, keeps what was typed, and converts only on the last step', async () => {
  await mountNewCustomer();
  expect(stepOf()).toBe('Organisation');
  const items = () =>
    [...dialog().querySelectorAll('[role="button"], button')].map((b) => b.textContent);
  expect(items()).toContain('Next');
  expect(items()).not.toContain('Convert');
  expect(items()).not.toContain('Back');
  // The legal name is a step-1 box; the opportunity name belongs to step 3.
  await fill(box('Legal name'), 'Renamed Supplies');
  await submit(dialog());
  expect(stepOf()).toBe('Contact');
  expect(items()).toContain('Back');
  expect(dialog().querySelector('[data-step-panel="0"]')?.hasAttribute('hidden')).toBe(true);
  await fill(dialog().querySelector('[name="contactName"]'), 'Mina Karki');
  await submit(dialog());
  expect(stepOf()).toBe('Deal');
  expect(items()).toContain('Convert');
  expect(items()).not.toContain('Next');
  expect(api.convertLead).not.toHaveBeenCalled();
  await click(
    [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Back') ?? null,
  );
  await click(
    [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Back') ?? null,
  );
  expect(stepOf()).toBe('Organisation');
  expect(box('Legal name').value).toBe('Renamed Supplies');
  expect(
    dialog().querySelector<HTMLInputElement>('[name="address.line"], textarea[name="address.line"]')
      ?.value,
  ).toBe('Balaju');
  await submit(dialog());
  expect(dialog().querySelector<HTMLInputElement>('[name="contactName"]')?.value).toBe(
    'Mina Karki',
  );
  await convert();
  expect(api.convertLead).toHaveBeenCalledTimes(1);
  expect(api.convertLead.mock.calls[0]?.[2]).toMatchObject({
    customer: { mode: 'create', customer: { legalName: 'Renamed Supplies' } },
    contact: { mode: 'create', contact: { fullName: 'Mina Karki' } },
  });
});

it('stays on a step that has a problem and says what it is, without losing the other steps', async () => {
  await mountNewCustomer();
  await fill(box('Legal name'), '');
  await submit(dialog());
  expect(stepOf()).toBe('Organisation');
  expect(dialog().querySelector('[aria-invalid="true"]')).not.toBeNull();
  expect(api.convertLead).not.toHaveBeenCalled();
});

it('a lead with no link starts on Create, with the organisation and the contact filled in from the lead', async () => {
  await mountNewCustomer({ companyName: 'Fresh Traders', contactName: 'Sita Rai' });
  expect(radio('customerMode', 'create')?.getAttribute('aria-checked') === 'true').toBe(true);
  expect(box('Legal name').value).toBe('Fresh Traders');
  expect(dialog().querySelector<HTMLInputElement>('[name="contactName"]')?.value).toBe('Sita Rai');
  // A new organisation has no contacts to link, so the contact step offers only Create.
  expect(dialog().querySelector('input[name="contactMode"][type="radio"]')).toBeNull();
  expect(api.listContacts).not.toHaveBeenCalled();
});

it('a lead linked to a customer starts on that customer, and the Contact step lists its people; there is no create-new default', async () => {
  api.listContacts.mockResolvedValue({
    items: [{ id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' }],
  });
  await mountNewCustomer({
    companyName: 'Himal Supplies Pvt. Ltd.',
    customerId: CUSTOMER,
    contactName: 'Mina',
  });
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerMode"]')?.value).toBe(
    'existing',
  );
  expect(dialog().querySelector('[name="legalName"]')).toBeNull();
  expect(box('Organisation').value).toBe('Himal Supplies Pvt. Ltd.');
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
  await flush();
  await submit(dialog());
  expect(stepOf()).toBe('Contact');
  await click(radio('contactMode', 'existing'));
  await click(box('Contact'));
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
    'Mina',
  ]);
  await typeKeys(box('Contact'), 'Zed');
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
    'Create "Zed"',
  ]);
});

it('shows a customer with the same PAN up front and "Use this customer" links it instead of creating a duplicate', async () => {
  api.listCustomers.mockImplementation((_session: unknown, query: { q?: string }) =>
    Promise.resolve(
      query.q === '601234567'
        ? {
            items: [
              PAN_CUSTOMER,
              { ...PAN_CUSTOMER, id: NO_MAIL, number: 'CUS-0099', panVatNo: '6012345670' },
            ],
            total: 2,
          }
        : { items: [], total: 0 },
    ),
  );
  api.listContacts.mockResolvedValue({
    items: [{ id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' }],
  });
  await mountNewCustomer({ companyName: 'Himalayan Trading' });
  await typeKeys(digitBox('panVatNo'), '601234567');
  await flush();
  const alert = dialog().querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('A customer with this PAN already exists');
  // Only the SAME number counts: CUS-0099 has a longer PAN that merely starts with it.
  expect(alert?.textContent).toContain('Himal Supplies Pvt. Ltd.');
  expect(alert?.textContent).toContain('CUS-0007');
  expect(alert?.textContent).not.toContain('CUS-0099');
  expect(api.listCustomers).toHaveBeenCalledWith(expect.anything(), { q: '601234567', limit: 20 });
  await click(
    [...dialog().querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Use this customer'),
    ) ?? null,
  );
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
  expect(dialog().querySelector('[name="legalName"]')).toBeNull();
  expect(box('Organisation').value).toContain('Himal Supplies Pvt. Ltd.');
  await flush();
  await convert();
  expect(api.convertLead).toHaveBeenCalledTimes(1);
  const body = api.convertLead.mock.calls[0]?.[2] as { customer: unknown };
  expect(body.customer).toEqual({ mode: 'existing', customerId: CUSTOMER });
});

it('legal name searches as you type and offers the matching customers to link; the typed name stays as a new one otherwise', async () => {
  api.listCustomers.mockImplementation((_session: unknown, query: { q?: string }) =>
    Promise.resolve(
      query.q === 'Himal' ? { items: [PAN_CUSTOMER], total: 1 } : { items: [], total: 0 },
    ),
  );
  await mountNewCustomer({ companyName: '' });
  await typeKeys(box('Legal name'), 'Himal');
  await flush();
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
    'Himal Supplies Pvt. Ltd.PAN/VAT 601234567 · CUS-0007',
    'Keep "Himal" as a new organisation',
  ]);
  await click([...document.querySelectorAll('[role="option"]')][0] ?? null);
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
});

it('the PAN box has no helper line and no "n of 9" count, a muted Optional on the label row, an example placeholder, and lines up with the legal name (UIP-FORM-008)', async () => {
  await mountNewCustomer();
  const pan = digitBox('panVatNo')!;
  await typeKeys(pan, '123');
  const field = pan.closest('[class*="field"]')!;
  const legal = box('Legal name').closest('[class*="field"]')!;
  expect(dialog().textContent).not.toContain('Nine digits');
  expect(dialog().textContent).not.toMatch(/\d of 9/);
  expect(field.querySelector('label')?.textContent).toBe('PAN or VAT number');
  expect(field.querySelector('[id$="-optional"]')?.textContent).toBe('Optional');
  expect(pan.placeholder).toBe('601234567');
  // Two fields in a row hold the same parts, so neither pushes the other's box out of line.
  expect([...field.children].map((c) => c.tagName)).toEqual(
    [...legal.children].map((c) => c.tagName),
  );
});

it('puts the search icon inside the organisation box and has no Search button anywhere in the wizard', async () => {
  await mountNewCustomer({ customerId: CUSTOMER });
  const wrap = box('Organisation').parentElement!;
  expect(wrap.querySelector('svg')).not.toBeNull();
  expect(
    [...dialog().querySelectorAll('button')].some((b) => /search/i.test(b.textContent ?? '')),
  ).toBe(false);
});

it('takes the user back to the step that holds a refusal: a customer match to step 1, a contact match to step 2', async () => {
  await showDuplicate({
    kind: 'customer',
    id: CUSTOMER,
    label: 'Himal Supplies',
    matchedOn: 'name',
  });
  expect(stepOf()).toBe('Organisation');
  expect(dialog().textContent).toContain('A matching record already exists');
});

it('a contact match takes the user back to the Contact step', async () => {
  await showDuplicate({
    kind: 'contact',
    id: CONTACT,
    customerId: CUSTOMER,
    label: 'Mina',
    matchedOn: 'email',
  });
  expect(stepOf()).toBe('Contact');
});

it('a half-typed phone left behind on the Contact step takes Next back to it instead of doing nothing', async () => {
  await mountNewCustomer();
  await submit(dialog());
  expect(stepOf()).toBe('Contact');
  await fill(dialog().querySelector('input[aria-label="Phone 1 number"]'), '981234567');
  await click(
    [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Back') ?? null,
  );
  expect(stepOf()).toBe('Organisation');
  await submit(dialog());
  await flush();
  expect(stepOf()).toBe('Contact');
  expect(dialog().textContent).toContain('A mobile number has 10 digits; this has 9.');
});

it('typing over the chosen organisation and leaving the box shows the chosen one again, the one that will be posted', async () => {
  await mountNewCustomer({ customerId: CUSTOMER, companyName: 'Himal Supplies Pvt. Ltd.' });
  await typeKeys(box('Organisation'), 'Zzz');
  await flush();
  await act(() => Promise.resolve(box('Organisation').blur()));
  await act(() => Promise.resolve(document.body.click()));
  expect(box('Organisation').value).toContain('Himal Supplies Pvt. Ltd.');
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
});

async function mountWithoutTyping(lead: Partial<ConvertLead>) {
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
      action={convertLeadAction}
    />,
  );
  await click(mounted.container.querySelector('button'));
}

it("D9: prefills the new customer's Address and City from the lead's address, and sends them unchanged", async () => {
  await mountWithoutTyping({ address: { line: '12 Lazimpat Road', city: 'Kathmandu' } });
  expect(dialog().querySelector<HTMLTextAreaElement>('[name="address.line"]')?.value).toBe(
    '12 Lazimpat Road',
  );
  expect(dialog().querySelector<HTMLInputElement>('[name="address.city"]')?.value).toBe(
    'Kathmandu',
  );
  await convert();
  expect(api.convertLead).toHaveBeenCalledTimes(1);
  expect(api.convertLead.mock.calls[0]?.[2]).toMatchObject({
    customer: {
      mode: 'create',
      customer: { country: 'NP', address: { line: '12 Lazimpat Road', city: 'Kathmandu' } },
    },
  });
});

it('D9: the prefilled address stays editable, and a lead without one starts empty', async () => {
  await mountWithoutTyping({ address: { line: '12 Lazimpat Road', city: 'Kathmandu' } });
  await fillAddress('Ward 4, Lakeside', 'Pokhara');
  await convert();
  expect(api.convertLead.mock.calls[0]?.[2]).toMatchObject({
    customer: { customer: { address: { line: 'Ward 4, Lakeside', city: 'Pokhara' } } },
  });
  await mounted.unmount();
  vi.clearAllMocks();
  await mountWithoutTyping({ address: null });
  expect(dialog().querySelector<HTMLTextAreaElement>('[name="address.line"]')?.value).toBe('');
  expect(dialog().querySelector<HTMLInputElement>('[name="address.city"]')?.value).toBe('');
});

// ---- R6T: linked leads -------------------------------------------------------------------------------------------

const unlinkAction = vi.fn();
async function mountLinked(lead: Partial<ConvertLead> = {}) {
  api.convertLead.mockRejectedValue(new ApiError(503, 'offline'));
  mounted = await mountForm(
    <ConvertDialog
      searchDelayMs={0}
      unlinkAction={unlinkAction}
      lead={{
        id: LEAD,
        version: 3,
        number: 'LEAD-1',
        title: 'Office supply',
        companyName: 'Himal Supplies Pvt. Ltd.',
        customerId: CUSTOMER,
        contactName: 'Mina',
        email: 'mina@himal.example',
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
  await flush();
}

const unlinkButton = () =>
  [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Unlink customer') ?? null;

it('a linked lead has no "new organisation" choice and no Create row, and can be unlinked', async () => {
  api.listContacts.mockResolvedValue({
    items: [{ id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' }],
  });
  await mountLinked();
  expect(dialog().querySelector('input[name="customerMode"][type="radio"]')).toBeNull();
  expect(dialog().querySelector('[name="legalName"]')).toBeNull();
  await typeKeys(box('Organisation'), 'Zzz');
  await flush();
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).not.toContain(
    'Create "Zzz"',
  );
  expect(unlinkButton()).not.toBeNull();
});

it('Unlink customer drops the link, starts the Create form with the lead company, and converts at the new version', async () => {
  unlinkAction.mockResolvedValue({ ok: true, version: 4 });
  api.listContacts.mockResolvedValue({
    items: [{ id: CONTACT, fullName: 'Mina', email: 'mina@himal.example' }],
  });
  await mountLinked({ address: { line: '12 Lazimpat Road', city: 'Kathmandu' } });
  await click(unlinkButton());
  await flush();
  expect(unlinkAction).toHaveBeenCalledWith(LEAD, 3);
  expect(unlinkButton()).toBeNull();
  expect(box('Legal name').value).toBe('Himal Supplies Pvt. Ltd.');
  expect(dialog().querySelector('input[name="customerMode"][type="radio"]')).not.toBeNull();
  expect(dialog().querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value).toBe(
    '4',
  );
  await fillAddress('Balaju', 'Kathmandu');
  await convert();
  expect(api.convertLead.mock.calls[0]?.[2]).toMatchObject({
    customer: { mode: 'create', customer: { legalName: 'Himal Supplies Pvt. Ltd.' } },
    expectedVersion: 4,
  });
});

it('a refused unlink says why and keeps the link', async () => {
  unlinkAction.mockResolvedValue({ ok: false, error: 'This record was changed by someone else.' });
  api.listContacts.mockResolvedValue({ items: [] });
  await mountLinked();
  await click(unlinkButton());
  await flush();
  expect(dialog().textContent).toContain('This record was changed by someone else.');
  expect(unlinkButton()).not.toBeNull();
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
});

it('a customer the converter cannot open is explained on the Organisation step, Next stops, and Unlink is offered', async () => {
  api.listContacts.mockRejectedValue(new ApiError(404, 'not found'));
  await mountLinked();
  expect(dialog().textContent).toContain('You cannot open this customer');
  expect(unlinkButton()).not.toBeNull();
  await submit(dialog());
  expect(stepOf()).toBe('Organisation');
  expect(api.convertLead).not.toHaveBeenCalled();
});

it('a linked contact without an email is explained, Next stops, and "create a contact from the lead" is offered', async () => {
  api.listContacts.mockResolvedValue({
    items: [{ id: NO_MAIL, fullName: 'Ravi', email: null }],
  });
  await mountLinked({ contactId: NO_MAIL, contactName: 'Ravi' });
  await submit(dialog());
  expect(stepOf()).toBe('Contact');
  expect(dialog().textContent).toContain('This contact has no email');
  await submit(dialog());
  expect(stepOf()).toBe('Contact');
  const fix = [...dialog().querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Create a contact from the lead'),
  );
  expect(fix).toBeDefined();
  await click(fix ?? null);
  expect(dialog().textContent).not.toContain('This contact has no email');
  await submit(dialog());
  expect(stepOf()).toBe('Deal');
});

it('a lead unlinked on the page while the dialog was mounted starts over as an unlinked lead, at the page version', async () => {
  api.listContacts.mockResolvedValue({ items: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const lead = (extra: Partial<ConvertLead>): ConvertLead => ({
    id: LEAD,
    version: 3,
    number: 'LEAD-1',
    title: 'Office supply',
    companyName: 'Himal Supplies Pvt. Ltd.',
    customerId: CUSTOMER,
    contactName: 'Mina',
    email: 'mina@himal.example',
    country: 'NP',
    phones: [],
    ...extra,
  });
  const render = (l: ConvertLead) =>
    act(() =>
      Promise.resolve(
        root.render(<ConvertDialog searchDelayMs={0} lead={l} action={convertLeadAction} />),
      ),
    );
  await render(lead({}));
  await click(container.querySelector('button'));
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')?.value).toBe(
    CUSTOMER,
  );
  await render(lead({ customerId: null, version: 4 }));
  expect(dialog().querySelector<HTMLInputElement>('input[name="customerId"]')).toBeNull();
  expect(box('Legal name').value).toBe('Himal Supplies Pvt. Ltd.');
  expect(dialog().querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value).toBe(
    '4',
  );
  await act(() => Promise.resolve(root.unmount()));
  container.remove();
});
