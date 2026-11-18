// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';
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
import { ConvertDialog } from './convert-dialog';
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
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
        phone: '',
      }}
      action={async (prev, form) => {
        submitted.push(form);
        return convertLeadAction(prev, form);
      }}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await fill(dialog().querySelector('[name="line1"]'), 'Balaju');
  await fill(dialog().querySelector('[name="city"]'), 'Kathmandu');
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
  await click(dialog().querySelector('input[name="contactMode"][value="existing"]'));
  const select = dialog().querySelector('select[name="contactId"]');
  expect(select?.textContent).toContain('Mina');
  const ravi = dialog().querySelector<HTMLOptionElement>(`option[value="${NO_MAIL}"]`);
  expect(ravi?.textContent).toBe('Ravi (no email address)');
  expect(ravi?.disabled).toBe(true);
  await fill(select, CONTACT);
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
    items: [{ id: CUSTOMER, legalName: 'Mountain Legal Ltd' }],
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
        phone: '',
      }}
      action={async (prev, form) => {
        submitted.push(form);
        return convertLeadAction(prev, form);
      }}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await click(dialog().querySelector('input[name="customerMode"][value="existing"]'));
  await fill(dialog().querySelector('input[maxlength="100"]'), 'Mountain');
  await click(
    [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Search') ?? null,
  );
  expect(api.listCustomers).toHaveBeenLastCalledWith(expect.anything(), {
    q: 'Mountain',
    limit: 20,
  });
  const customers = dialog().querySelector('select[name="customerId"]');
  expect(customers?.textContent).toContain('Mountain Legal Ltd');
  await fill(customers, CUSTOMER);
  expect(api.listContacts).toHaveBeenCalledWith(expect.anything(), CUSTOMER);
  await click(dialog().querySelector('input[name="contactMode"][value="existing"]'));
  await fill(dialog().querySelector('select[name="contactId"]'), CONTACT);
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
        phone: '',
      }}
      action={convertLeadAction}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await fill(dialog().querySelector('[name="line1"]'), 'Balaju');
  await fill(dialog().querySelector('[name="city"]'), 'Kathmandu');
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
