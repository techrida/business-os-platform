// @vitest-environment jsdom
import { CustomerDtoSchema, type CustomerDto } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { click, mountForm } from '@/test/form-interactions';

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
  address: { line1: 'Balaju', city: 'Kathmandu', country: 'NP' },
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
  line1: 'Balaju',
  city: 'Kathmandu',
  contactName: 'Sita Rai',
  contactEmail: 'sita@himalayan.example',
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
