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
const api = vi.hoisted(() => ({ convertLead: vi.fn(), listContacts: vi.fn() }));
vi.mock('./crm-api', () => ({ convertLead: api.convertLead }));
vi.mock('@/components/p2/customers/api', () => ({ listContacts: api.listContacts }));

import { convertLeadAction, loadConvertContacts } from '@/app/(app)/leads/actions';
import { ConvertDialog } from './convert-dialog';
import type { DuplicateInfo } from './types';

const LEAD = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
let mounted: Awaited<ReturnType<typeof mountForm>>;
let submitted: FormData[];
beforeEach(() => {
  vi.clearAllMocks();
  submitted = [];
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(async () => {
  await mounted?.unmount();
});

async function showDuplicate(duplicate: DuplicateInfo) {
  api.convertLead
    .mockRejectedValueOnce(
      new ApiError(409, 'duplicate', {
        error: { code: 'duplicate_found', duplicates: [duplicate] },
      }),
    )
    .mockRejectedValue(new ApiError(503, 'offline'));
  api.listContacts.mockResolvedValue({ items: [{ id: CONTACT, fullName: 'Mina' }] });
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
      loadContacts={loadConvertContacts}
    />,
  );
  await click(mounted.container.querySelector('button'));
  await fill(mounted.container.querySelector('[name="line1"]'), 'Balaju');
  await fill(mounted.container.querySelector('[name="city"]'), 'Kathmandu');
  await submit(mounted.container);
  expect(api.convertLead).toHaveBeenCalledTimes(1);
  const useExisting = [...mounted.container.querySelectorAll('button')].find((b) =>
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
  await submit(mounted.container);
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

it('selects a named contact with neither email nor phone for an existing customer and submits it', async () => {
  await showDuplicate({
    kind: 'customer',
    id: CUSTOMER,
    label: 'Himal Supplies',
    matchedOn: 'name',
  });
  expect(api.listContacts).toHaveBeenCalledWith(expect.anything(), CUSTOMER);
  await click(mounted.container.querySelector('input[name="contactMode"][value="existing"]'));
  const select = mounted.container.querySelector('select[name="contactId"]');
  expect(select?.textContent).toContain('Mina');
  await fill(select, CONTACT);
  await submit(mounted.container);
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
  expect(mounted.container.textContent).not.toContain(CONTACT);
  expect(mounted.container.textContent).not.toContain('customer screens');
});
