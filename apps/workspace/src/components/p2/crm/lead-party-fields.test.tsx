// @vitest-environment jsdom
// BOS-UI-002 on New lead: the Company and Contact person fields are search-and-create comboboxes. Real LeadForm,
// real Combobox, fake data sources (the page passes the BFF routes). What matters: Create "<text>" is always last and
// is the default, so Enter or saving without picking keeps today's free-text lead; picking a customer links it and
// fills its country; a lead in "Already a lead" only navigates; the contact field searches the linked customer's
// contacts and is a plain input without one.
import type { LeadDuplicateMatch } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LeadContactOption } from '@/app/(app)/leads/_lib/customer-contacts';
import { choose, click, fill, mountForm, settle } from '@/test/form-interactions';

import { parseLead } from './forms';
import { LeadForm } from './lead-form';
import type { FormAction } from './types';

const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const LEAD = '55555555-5555-4555-8555-555555555555';
const ASHA = '77777777-7777-4777-8777-777777777777';
const BINOD = '88888888-8888-4888-8888-888888888888';
const MATCHES: LeadDuplicateMatch[] = [
  { kind: 'lead', id: LEAD, label: 'Himalayan Traders (LD-2083/84-00001)', matchedOn: ['company'] },
  {
    kind: 'customer',
    id: CUSTOMER,
    label: 'Himalayan Traders Pvt. Ltd.',
    country: 'IN',
    matchedOn: ['company'],
  },
];
const CONTACTS: LeadContactOption[] = [
  { id: ASHA, name: 'Asha Rai', detail: 'asha@himalayan.example' },
  { id: BINOD, name: 'Binod Karki', detail: null },
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  document.body.innerHTML = '';
});

async function mountLead(
  opts: { matches?: LeadDuplicateMatch[]; contacts?: LeadContactOption[] } = {},
) {
  const action = vi.fn<FormAction>().mockResolvedValue({ values: {}, fieldErrors: {} });
  const search = vi.fn(async () => opts.matches ?? MATCHES);
  const loadContacts = vi.fn(async () => opts.contacts ?? CONTACTS);
  const onOpenLead = vi.fn();
  const mounted = await mountForm(
    <LeadForm
      action={action}
      sources={[{ label: 'Referral', value: 'referral' }]}
      owners={[]}
      enabledCurrencies={['NPR']}
      idempotencyKey="44444444-4444-4444-8444-444444444444"
      companySearch={search}
      companySearchDelayMs={0}
      loadContacts={loadContacts}
      onOpenLead={onOpenLead}
    />,
  );
  const { container } = mounted;
  await fill(container.querySelector('[name="title"]'), 'Racks');
  await choose(container, 'source', 'Referral');
  await fill(container.querySelector('[name="email"]'), 'buyer@himalayan.example');
  const company = () => container.querySelector<HTMLInputElement>('input[name="companyName"]')!;
  const contact = () => container.querySelector<HTMLInputElement>('input[name="contactName"]')!;
  const settleSearch = async () => {
    await settle();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const options = () =>
    Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());
  const activeOption = (input: HTMLInputElement) => {
    const id = input.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.textContent?.trim() : null;
  };
  const posted = async () => {
    await click(container.querySelector('button[type="submit"]'));
    return action.mock.calls.at(-1)![1];
  };
  const key = (target: Element, name: string) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      );
      return Promise.resolve();
    });
  return {
    ...mounted,
    action,
    search,
    loadContacts,
    onOpenLead,
    company,
    contact,
    settleSearch,
    options,
    activeOption,
    posted,
    key,
  };
}

it('lists customers, then "Already a lead", then Create "<text>" last and highlighted', async () => {
  const t = await mountLead();
  await fill(t.company(), 'Himalayan');
  await t.settleSearch();
  expect(t.search).toHaveBeenCalledWith('Himalayan', expect.anything());
  expect(t.options()).toEqual([
    expect.stringContaining('Himalayan Traders Pvt. Ltd.'),
    expect.stringContaining('Himalayan Traders (LD-2083/84-00001)'),
    'Create "Himalayan"',
  ]);
  const headings = Array.from(document.querySelectorAll('[role="listbox"] [role="group"]')).map(
    (g) => g.firstElementChild?.textContent?.trim(),
  );
  // The Create row sits outside both groups, under no heading.
  expect(headings).toEqual(['Customers', 'Already a lead']);
  expect(t.activeOption(t.company())).toBe('Create "Himalayan"');
  await t.unmount();
});

it('keeps the typed text as a new company on Enter, links nothing and never submits the form', async () => {
  const t = await mountLead();
  await fill(t.company(), 'Himalayan');
  await t.settleSearch();
  await t.key(t.company(), 'Enter');
  expect(t.action).not.toHaveBeenCalled();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(t.company().value).toBe('Himalayan');
  await fill(t.contact(), 'Sunita Shrestha');
  const data = await t.posted();
  expect(data.get('companyName')).toBe('Himalayan');
  expect(data.has('customerId')).toBe(false);
  expect(parseLead(data)).toMatchObject({ ok: true, data: { companyName: 'Himalayan' } });
  await t.unmount();
});

it('saves a typed company with no pick at all, exactly as a plain input did', async () => {
  const t = await mountLead();
  await fill(t.company(), 'Brand New Traders');
  await fill(t.contact(), 'Sunita Shrestha');
  const data = await t.posted();
  expect(t.action).toHaveBeenCalledTimes(1);
  expect(data.get('companyName')).toBe('Brand New Traders');
  expect(data.has('customerId')).toBe(false);
  await t.unmount();
});

it('offers Create even when a customer has exactly the typed name', async () => {
  const t = await mountLead({
    matches: [{ kind: 'customer', id: CUSTOMER, label: 'Himalayan', matchedOn: ['company'] }],
  });
  await fill(t.company(), 'Himalayan');
  await t.settleSearch();
  expect(t.options()).toEqual([expect.stringContaining('Himalayan'), 'Create "Himalayan"']);
  await t.unmount();
});

it('links a picked customer, fills its name and country, and posts the link', async () => {
  const t = await mountLead();
  await fill(t.company(), 'Himal');
  await t.settleSearch();
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((o) =>
    o.textContent?.includes('Pvt. Ltd.'),
  );
  await click(option ?? null);
  expect(t.company().value).toBe('Himalayan Traders Pvt. Ltd.');
  await fill(t.contact(), 'Sunita Shrestha');
  const data = await t.posted();
  expect(data.get('customerId')).toBe(CUSTOMER);
  expect(data.get('country')).toBe('IN');
  expect(parseLead(data)).toMatchObject({
    ok: true,
    data: { companyName: 'Himalayan Traders Pvt. Ltd.', customerId: CUSTOMER, country: 'IN' },
  });
  await t.unmount();
});

it('unlinks the customer when the text is edited or cleared', async () => {
  const t = await mountLead();
  await fill(t.company(), 'Himal');
  await t.settleSearch();
  await click(document.querySelector<HTMLElement>('[role="option"]'));
  expect(t.company().closest('form')!.querySelector('input[name="customerId"]')).not.toBeNull();
  await fill(t.company(), 'Himalayan Traders Pvt. Ltd. Pokhara');
  expect(t.company().closest('form')!.querySelector('input[name="customerId"]')).toBeNull();

  await fill(t.company(), 'Himal');
  await t.settleSearch();
  await click(document.querySelector<HTMLElement>('[role="option"]'));
  expect(t.company().closest('form')!.querySelector('input[name="customerId"]')).not.toBeNull();
  await fill(t.company(), '');
  expect(t.company().closest('form')!.querySelector('input[name="customerId"]')).toBeNull();
  await t.unmount();
});

it('opens a lead from "Already a lead" without filling or linking anything', async () => {
  const t = await mountLead();
  await fill(t.company(), 'Himal');
  await t.settleSearch();
  const lead = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((o) =>
    o.textContent?.includes('LD-2083/84-00001'),
  );
  await click(lead ?? null);
  expect(t.onOpenLead).toHaveBeenCalledWith(LEAD);
  expect(t.company().value).toBe('Himal');
  expect(t.company().closest('form')!.querySelector('input[name="customerId"]')).toBeNull();
  await t.unmount();
});

it('makes Contact person a plain input until a customer is linked', async () => {
  const t = await mountLead();
  expect(t.contact().getAttribute('role')).toBeNull();
  await fill(t.company(), 'Brand New Traders');
  expect(t.contact().getAttribute('role')).toBeNull();
  expect(t.loadContacts).not.toHaveBeenCalled();
  await t.unmount();
});

async function linkCustomer(t: Awaited<ReturnType<typeof mountLead>>) {
  await fill(t.company(), 'Himal');
  await t.settleSearch();
  const customer = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((o) =>
    o.textContent?.includes('Pvt. Ltd.'),
  );
  await click(customer ?? null);
  await t.settleSearch();
}

it("searches the linked customer's contacts, with Create last, and posts the picked one", async () => {
  const t = await mountLead();
  await linkCustomer(t);
  expect(t.loadContacts).toHaveBeenCalledWith(CUSTOMER, expect.anything());
  expect(t.contact().getAttribute('role')).toBe('combobox');
  await fill(t.contact(), 'Bin');
  expect(t.options()).toEqual([expect.stringContaining('Binod Karki'), 'Create "Bin"']);
  await click(document.querySelector<HTMLElement>('[role="option"]'));
  expect(t.contact().value).toBe('Binod Karki');
  const data = await t.posted();
  expect(data.get('contactId')).toBe(BINOD);
  expect(parseLead(data)).toMatchObject({
    ok: true,
    data: { customerId: CUSTOMER, contactId: BINOD, contactName: 'Binod Karki' },
  });
  await t.unmount();
});

it('keeps a new contact name on Enter with the customer linked, posting no contact link', async () => {
  const t = await mountLead();
  await linkCustomer(t);
  await fill(t.contact(), 'Sunita Shrestha');
  expect(t.activeOption(t.contact())).toBe('Create "Sunita Shrestha"');
  await t.key(t.contact(), 'Enter');
  expect(t.action).not.toHaveBeenCalled();
  const data = await t.posted();
  expect(data.get('contactName')).toBe('Sunita Shrestha');
  expect(data.get('customerId')).toBe(CUSTOMER);
  expect(data.has('contactId')).toBe(false);
  await t.unmount();
});

it('drops the contact link with the customer link', async () => {
  const t = await mountLead();
  await linkCustomer(t);
  await fill(t.contact(), 'Asha');
  await click(document.querySelector<HTMLElement>('[role="option"]'));
  expect(t.contact().closest('form')!.querySelector('input[name="contactId"]')).not.toBeNull();
  await fill(t.company(), 'Something else');
  const form = t.contact().closest('form')!;
  expect(form.querySelector('input[name="contactId"]')).toBeNull();
  expect(form.querySelector('input[name="customerId"]')).toBeNull();
  expect(t.contact().getAttribute('role')).toBeNull();
  expect(t.contact().value).toBe('Asha Rai');
  await t.unmount();
});

it('stays usable when the search or the contacts list fails: only Create is offered', async () => {
  const t = await mountLead();
  t.search.mockRejectedValue(new Error('down'));
  await fill(t.company(), 'Himalayan');
  await t.settleSearch();
  expect(t.options()).toEqual(['Create "Himalayan"']);
  await t.unmount();
});
