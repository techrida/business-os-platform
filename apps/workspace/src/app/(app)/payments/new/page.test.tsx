// @vitest-environment jsdom
// jsdom for the one test that opens the pickers; the page tests render static markup either way.
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { choose, click, mountForm } from '@/test/form-interactions';

import { ID as INVOICE_ID, invoiceDetail } from '../../invoices/_lib/test-fixtures';
import { CUSTOMER_ID } from '../_lib/fixtures';

import NewPaymentPage from './page';
import { PaymentForm, startCurrency } from './payment-form';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listCustomers: vi.fn(),
  getCustomer: vi.fn(),
  getInvoice: vi.fn(),
  apiFetch: vi.fn(),
  getMe: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/customers/api', () => ({
  listCustomers: mocks.listCustomers,
  getCustomer: mocks.getCustomer,
}));
vi.mock('@/lib/api-billing', () => ({ getInvoice: mocks.getInvoice }));
// The enabled-currency list comes through the real `loadEnabledCurrencies` from the display read.
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
  getMe: mocks.getMe,
}));
// The form's action is a server action; the page test never submits it.
vi.mock('./actions', () => ({ recordPaymentAction: vi.fn() }));

/** GET /v1/me with the live grants Settings > Access gives the caller's roles. */
const liveGrants = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

const OTHER_ID = '99999999-9999-4999-8999-999999999999';

function customer(over: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    number: 'CUS-0001',
    legalName: 'Himalayan Traders Pvt. Ltd.',
    panVatNo: null,
    industry: null,
    relationship: 'active',
    ownerUserId: null,
    defaultCurrency: 'NPR',
    address: {},
    mergedIntoId: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** The display settings read, answering with these enabled currencies. A fresh body per call. */
function enabledAre(list: readonly string[]) {
  mocks.apiFetch.mockImplementation(() =>
    Promise.resolve(
      Response.json({ numberSystems: {}, dateFormat: 'dd MMM yyyy', enabledCurrencies: list }),
    ),
  );
}

/**
 * The currency picker's own markup (its submitted hidden input and the option list React Aria
 * renders), so the other selects on the page cannot satisfy an assertion.
 */
function currencySelect(html: string): string {
  return />Currency<\/label>.*?<\/select>/s.exec(html)?.[0] ?? '';
}

async function render(
  query: { customerId?: string; invoiceId?: string; amount?: string; q?: string } = {},
): Promise<string> {
  return renderToStaticMarkup(await NewPaymentPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.listCustomers.mockResolvedValue({ items: [customer()], total: 1 });
  mocks.getCustomer.mockRejectedValue(new ApiError(404, 'no'));
  enabledAre(['NPR', 'INR', 'USD']);
  mocks.getInvoice.mockRejectedValue(new ApiError(404, 'no'));
  // Without a live answer the gate falls back to the role defaults.
  mocks.getMe.mockRejectedValue(new Error('GET /v1/me failed'));
});

describe('record payment page', () => {
  it('shows the form with customers, the fields, proof and a hidden idempotency key', async () => {
    const html = await render();
    expect(html).toContain('Record payment');
    expect(html).toContain('Himalayan Traders Pvt. Ltd. (CUS-0001)');
    for (const label of [
      'Customer',
      'Currency',
      'Amount received',
      'Payment method',
      'Received on',
      'Bank reference',
      'Tax withheld',
      'Withholding code',
      'Add proof files',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/<input type="hidden" name="idempotencyKey" value="[0-9a-f-]{36}"\/>/);
    expect(html).toContain('type="file"');
    expect(html).toContain('Choose the customer first.');
    expect(html).not.toContain('Find a customer');
  });

  it('puts the Figma eyebrow above each card title, hidden from the heading name', async () => {
    const html = await render();
    expect(html).toMatch(
      /<h2[^>]*><span[^>]*aria-hidden="true"[^>]*>01 · The basics<\/span>Payment details<\/h2>/,
    );
    expect(html).toMatch(
      /<h2[^>]*><span[^>]*aria-hidden="true"[^>]*>02 · The proof<\/span>Proof of payment<\/h2>/,
    );
  });

  it('gives each render its own idempotency key', async () => {
    const key = (h: string) => /name="idempotencyKey" value="([^"]+)"/.exec(h)?.[1];
    expect(key(await render())).not.toBe(key(await render()));
  });

  it('preselects a customer named in the link and lets the file picker open', async () => {
    const html = await render({ customerId: CUSTOMER_ID });
    expect(html).toContain(`name="customerId" value="${CUSTOMER_ID}"`);
    expect(html).toContain('You can add several files at once.');
  });

  it('adds a linked customer the list did not return, and ignores one that is merged or unreadable', async () => {
    mocks.getCustomer.mockResolvedValue(customer({ id: OTHER_ID, legalName: 'Linked Co' }));
    expect(await render({ customerId: OTHER_ID })).toContain('Linked Co (CUS-0001)');
    mocks.getCustomer.mockResolvedValue(
      customer({ id: OTHER_ID, legalName: 'Merged Co', mergedIntoId: CUSTOMER_ID }),
    );
    expect(await render({ customerId: OTHER_ID })).not.toContain('Merged Co');
    mocks.getCustomer.mockRejectedValue(new ApiError(500, 'x'));
    expect(await render({ customerId: OTHER_ID })).toContain('Himalayan Traders');
  });

  it('leaves merged customers out of the picker', async () => {
    mocks.listCustomers.mockResolvedValue({
      items: [
        customer(),
        customer({ id: OTHER_ID, legalName: 'Old Co', mergedIntoId: CUSTOMER_ID }),
      ],
      total: 2,
    });
    expect(await render()).not.toContain('Old Co');
  });

  it('offers a search when the list is cut off, and passes the search text on', async () => {
    mocks.listCustomers.mockResolvedValue({
      items: Array.from({ length: 100 }, (_, i) =>
        customer({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
      ),
      total: 240,
    });
    const html = await render();
    expect(html).toContain('Find a customer');
    expect(html).toContain('Showing the first 100');
    await render({ q: ' Himal ' });
    expect(mocks.listCustomers).toHaveBeenLastCalledWith(expect.anything(), {
      q: 'Himal',
      limit: 100,
    });
  });

  it('has an empty state, and a different one when a search finds nothing', async () => {
    mocks.listCustomers.mockResolvedValue({ items: [], total: 0 });
    const none = await render();
    expect(none).toContain('There are no customers yet.');
    expect(none).toContain('href="/customers/new"');
    expect(none).not.toContain('Record payment</button>');
    const searched = await render({ q: 'zzz' });
    expect(searched).toContain('No customers match that search.');
    expect(searched).toContain('Clear search');
  });

  it('says the roles lack customers on a 403, and offers a reload on another error', async () => {
    mocks.listCustomers.mockRejectedValue(new ApiError(403, 'no'));
    const denied = await render();
    expect(denied).toContain('Your roles do not include customers');
    expect(denied).not.toContain('Reload the form');
    mocks.listCustomers.mockRejectedValue(new ApiError(500, 'boom'));
    const failed = await render();
    expect(failed).toContain('The customers did not load');
    expect(failed).toContain('Reload the form');
  });

  it('is a plain notice, with no form and no customer lookup, for roles without payment.record', async () => {
    for (const roles of [[], ['management'], ['sales']]) {
      mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles });
      const html = await render();
      expect(html).toContain('Your roles do not include recording payments');
      expect(html).not.toContain('<form');
    }
    expect(mocks.listCustomers).not.toHaveBeenCalled();
  });

  it('shows the form to a role granted payment.record in Settings > Access, and not to one it was taken from', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    mocks.getMe.mockResolvedValue(liveGrants('payment.read', 'payment.record'));
    expect(await render()).toContain('<form');
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.getMe.mockResolvedValue(liveGrants('payment.read'));
    expect(await render()).toContain('Your roles do not include recording payments');
  });

  it('keeps a very long customer name in the option text', async () => {
    mocks.listCustomers.mockResolvedValue({
      items: [customer({ legalName: 'N'.repeat(400) })],
      total: 1,
    });
    expect(await render()).toContain('N'.repeat(400));
  });

  it('returns here after sign-in, with the customer kept', async () => {
    await render({ customerId: CUSTOMER_ID });
    expect(mocks.requireStaffSession).toHaveBeenCalledWith(
      `/payments/new?customerId=${CUSTOMER_ID}`,
    );
  });

  it('offers every currency, choosable, and names the ones switched off in Settings', async () => {
    enabledAre(['NPR', 'USD']);
    const picker = currencySelect(await render());
    expect(picker).toContain('<option value="NPR"');
    expect(picker).toContain('<option value="USD">USD (US dollar)</option>');
    // Old code left INR out: a payment that arrived in INR could not be recorded.
    expect(picker).toContain('<option value="INR">INR (Indian rupee), switched off</option>');
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/settings/display',
      undefined,
    );
  });

  it('starts blank when the customer’s usual currency is switched off, and names it on the field', async () => {
    enabledAre(['NPR', 'INR']);
    mocks.listCustomers.mockResolvedValue({
      items: [customer({ defaultCurrency: 'USD' })],
      total: 1,
    });
    const html = await render({ customerId: CUSTOMER_ID });
    const picker = currencySelect(html);
    // Old code started on NPR without asking.
    expect(picker).toContain('<input type="hidden" name="currency" value=""/>');
    expect(picker).toContain('data-placeholder="true">Choose a currency</span>');
    expect(picker).toContain('<option value="USD">USD (US dollar), switched off</option>');
    expect(html).toContain(
      'This customer usually pays in USD (US dollar), which is switched off in Settings. Payments in it are still recorded.',
    );
  });

  it('starts on the customer’s usual currency while it is enabled, with no warning', async () => {
    mocks.listCustomers.mockResolvedValue({
      items: [customer({ defaultCurrency: 'USD' })],
      total: 1,
    });
    const html = await render({ customerId: CUSTOMER_ID });
    expect(currencySelect(html)).toContain('<input type="hidden" name="currency" value="USD"/>');
    expect(html).not.toContain('switched off in Settings');
  });

  it('falls back to the default list when the settings read fails', async () => {
    mocks.apiFetch.mockRejectedValue(new ApiError(503, 'down'));
    const picker = currencySelect(await render());
    for (const c of ['NPR', 'INR', 'USD']) expect(picker).toContain(`<option value="${c}"`);
  });

  it('never starts a payment on a switched-off currency, nor moves it to NPR', () => {
    expect(startCurrency('USD', ['NPR', 'USD'])).toBe('USD');
    expect(startCurrency('USD', ['NPR', 'INR'])).toBe('');
    expect(startCurrency(null, ['NPR', 'INR'])).toBe('NPR');
    expect(startCurrency(undefined, ['NPR'])).toBe('NPR');
  });

  describe('opened from an invoice (U16-Q8 a)', () => {
    /** GET /v1/invoices/:id for an issued USD invoice of 2,018,180.00 with 750.00 still open. */
    const owed = (invoice: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) => ({
      ...invoiceDetail({ status: 'issued', currency: 'USD', ...invoice }),
      settlement: 'partly_paid',
      openAmount: '750.00',
      ...rest,
    });
    const amountInput = (html: string) => /<input[^>]*name="amount"[^>]*>/.exec(html)?.[0] ?? '';

    it('starts on the invoice currency and the open amount the API reports, not an amount in the link', async () => {
      mocks.getInvoice.mockResolvedValue(owed());
      const html = await render({ customerId: CUSTOMER_ID, invoiceId: INVOICE_ID, amount: '1' });
      expect(mocks.getInvoice).toHaveBeenCalledWith(expect.anything(), INVOICE_ID);
      // Old code started blank: no invoice read, no amount.
      expect(amountInput(html)).toContain('value="750.00"');
      expect(html).not.toContain('value="1"');
      expect(html).not.toContain('2018180.00');
      // The customer's usual currency is NPR; the invoice's own currency wins.
      expect(currencySelect(html)).toContain('<input type="hidden" name="currency" value="USD"/>');
      expect(html).toContain('The open amount of INV-2083/84-00001. Change it for a part payment.');
      expect(mocks.requireStaffSession).toHaveBeenCalledWith(
        `/payments/new?customerId=${CUSTOMER_ID}&invoiceId=${INVOICE_ID}`,
      );
    });

    it.each([
      ['another customer’s invoice', owed({ customerId: OTHER_ID })],
      ['a settled invoice', owed({}, { settlement: 'paid', openAmount: '0.00' })],
      ['a credited invoice', owed({}, { settlement: 'credited', openAmount: '0.00' })],
      ['an invoice with no derived settlement', owed({}, { settlement: null, openAmount: null })],
      [
        'an older API without the open amount',
        owed({}, { settlement: undefined, openAmount: undefined }),
      ],
      ['a discarded draft', owed({ status: 'discarded' })],
      [
        'a credit note',
        owed({ kind: 'credit_note', originalInvoiceId: OTHER_ID, noteReason: 'Returned goods' }),
      ],
      [
        'an invoice whose grant does not reach the customer',
        owed(
          {},
          {
            can: {
              submit: false,
              issue: false,
              discard: false,
              notes: false,
              recordPayment: false,
            },
          },
        ),
      ],
    ])('stays blank, with no error, for %s', async (_, detail) => {
      mocks.getInvoice.mockResolvedValue(detail);
      const html = await render({ customerId: CUSTOMER_ID, invoiceId: INVOICE_ID });
      expect(amountInput(html)).toContain('value=""');
      expect(currencySelect(html)).toContain('<input type="hidden" name="currency" value="NPR"/>');
      expect(html).not.toContain('The open amount of');
      expect(html).not.toContain('role="alert"');
    });

    it('stays blank, with no error, when the invoice is not found or not readable', async () => {
      for (const status of [404, 403, 500]) {
        mocks.getInvoice.mockRejectedValue(new ApiError(status, 'Invoice INV-SECRET not found'));
        const html = await render({ customerId: CUSTOMER_ID, invoiceId: INVOICE_ID });
        expect(amountInput(html)).toContain('value=""');
        expect(html).not.toContain('INV-SECRET');
        expect(html).not.toContain('role="alert"');
      }
    });

    it('stays blank when the linked customer is not in the picker', async () => {
      mocks.getInvoice.mockResolvedValue(owed({ customerId: OTHER_ID }));
      const html = await render({ customerId: OTHER_ID, invoiceId: INVOICE_ID });
      expect(amountInput(html)).toContain('value=""');
    });

    it('reads no invoice for the standalone form, a customer-only link or an invoice without a customer', async () => {
      mocks.getInvoice.mockResolvedValue(owed());
      for (const query of [
        {},
        { customerId: CUSTOMER_ID },
        { invoiceId: INVOICE_ID },
        { customerId: CUSTOMER_ID, invoiceId: 'not-a-uuid' },
        { customerId: CUSTOMER_ID, amount: '750.00' },
      ]) {
        const html = await render(query);
        expect(amountInput(html)).toContain('value=""');
        expect(html).toContain('The cash that arrived, for example 20,18,180.00.');
      }
      expect(mocks.getInvoice).not.toHaveBeenCalled();
    });
  });

  describe('choosing a customer in the form', () => {
    let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
    beforeEach(() => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    });
    afterEach(async () => {
      await mounted?.unmount();
      mounted = undefined;
      document.body.innerHTML = '';
    });

    const optionStates = () =>
      Array.from(document.querySelectorAll('[role="option"]')).map(
        (o) =>
          `${o.textContent?.trim()}${o.getAttribute('aria-disabled') === 'true' ? ' (off)' : ''}`,
      );

    it('blanks the currency for a customer whose usual one is off, and the switched-off one stays choosable', async () => {
      mounted = await mountForm(
        <PaymentForm
          idempotencyKey="11111111-1111-4111-8111-111111111111"
          today="2026-11-19"
          customers={[
            { id: CUSTOMER_ID, name: 'Rupee Co', number: 'CUS-0001', defaultCurrency: 'INR' },
            { id: OTHER_ID, name: 'Dollar Co', number: 'CUS-0002', defaultCurrency: 'USD' },
          ]}
          enabledCurrencies={['NPR', 'INR']}
          initialCustomerId=""
          reloadHref="/payments/new"
        />,
      );
      const box = mounted.container;
      const currency = () =>
        box.querySelector<HTMLInputElement>('input[type="hidden"][name="currency"]')?.value;
      const customerTrigger = box.querySelector<HTMLButtonElement>(
        `button#${CSS.escape(box.querySelector('label[for]')!.getAttribute('for')!)}`,
      );

      await click(customerTrigger);
      await click(
        Array.from(document.querySelectorAll('[role="option"]')).find(
          (o) => o.textContent?.trim() === 'Rupee Co (CUS-0001)',
        ) ?? null,
      );
      expect(currency()).toBe('INR');

      await click(customerTrigger);
      await click(
        Array.from(document.querySelectorAll('[role="option"]')).find(
          (o) => o.textContent?.trim() === 'Dollar Co (CUS-0002)',
        ) ?? null,
      );
      // Old code moved the payment to NPR without asking.
      expect(currency()).toBe('');
      expect(box.textContent).toContain(
        'This customer usually pays in USD (US dollar), which is switched off in Settings.',
      );

      await choose(box, 'currency', 'USD (US dollar), switched off');
      expect(currency()).toBe('USD');
      expect(box.textContent).toContain(
        'USD (US dollar) is switched off in Settings. Payments in it are still recorded.',
      );
      await click(
        box.querySelector('input[name="currency"]')!.parentElement!.querySelector('button'),
      );
      // Old code showed USD disabled, so a payment that arrived in USD could not be recorded.
      expect(optionStates()).toEqual([
        'NPR (Nepalese rupee)',
        'INR (Indian rupee)',
        'USD (US dollar), switched off',
      ]);
      await act(() => Promise.resolve());
      // Opening React Aria pickers in jsdom takes a few seconds; room for a loaded full suite.
    }, 15_000);
  });
});
