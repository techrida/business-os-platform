import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOMER, ID, KEY, TAX } from '../_lib/test-fixtures';

import { createManualInvoiceAction } from './actions';
import type { InvoiceFormState } from './form-state';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  getMe: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
  loadEnabledCurrencies: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/enabled-currencies.server', () => ({
  loadEnabledCurrencies: mocks.loadEnabledCurrencies,
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
  getMe: mocks.getMe,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const prev: InvoiceFormState = { key: KEY, errors: {} };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LINE = {
  key: 'l1',
  description: 'Hosting, one year',
  uom: 'yr',
  quantity: '1',
  unitPrice: '12,000.00',
  taxCodeId: TAX,
};

function form(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  const all: Record<string, string> = {
    customerId: CUSTOMER,
    currency: 'NPR',
    manualReason: 'Work done before the order was confirmed.',
    dueDate: '2026-12-08',
    lines: JSON.stringify([LINE]),
    idempotencyKey: KEY,
    ...over,
  };
  for (const [k, v] of Object.entries(all)) f.append(k, v);
  return f;
}

/** A response the way the API sends an invoice detail (parsed with the contract by the client). */
async function detailBody() {
  const { invoiceDetail } = await import('../_lib/test-fixtures');
  return invoiceDetail({ manualReason: 'Work done.', salesOrderId: null });
}

const IN_PROGRESS = {
  error: {
    code: 'conflict',
    message: 'A request with this Idempotency-Key is still being processed.',
  },
};

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const call = () => mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];

beforeEach(async () => {
  vi.clearAllMocks();
  // Until a test sets live grants, GET /v1/me fails and the role defaults decide.
  mocks.getMe.mockRejectedValue(new Error('upstream down'));
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.loadEnabledCurrencies.mockResolvedValue(['NPR', 'INR', 'USD']);
  const body = await detailBody();
  mocks.apiFetch.mockImplementation(() => answer(201, body));
  mocks.redirect.mockImplementation((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  });
});

describe('createManualInvoiceAction', () => {
  it('posts the contract body with the page key, then opens the new invoice the server answered with', async () => {
    await expect(createManualInvoiceAction(prev, form())).rejects.toThrow(
      `REDIRECT /invoices/${ID}`,
    );
    const [, path, init] = call();
    expect(path).toBe('/v1/invoices');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      customerId: CUSTOMER,
      currency: 'NPR',
      manualReason: 'Work done before the order was confirmed.',
      dueDate: '2026-12-08',
      lines: [
        {
          description: 'Hosting, one year',
          uom: 'yr',
          quantity: '1',
          unitPrice: '12000.00',
          taxCodeId: TAX,
        },
      ],
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/invoices');
  });

  it('sends no number, issue date or total, whatever the form posted', async () => {
    const f = form();
    f.append('number', 'INV-1');
    f.append('issueDate', '2020-01-01');
    f.append('total', '1');
    await expect(createManualInvoiceAction(prev, f)).rejects.toThrow('REDIRECT');
    const sent = JSON.parse(call()[2].body as string) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      'currency',
      'customerId',
      'dueDate',
      'lines',
      'manualReason',
    ]);
  });

  it('sends the document discount the form chose, as the contract shape', async () => {
    // Fails on the old code: the action never read discountMode or discountValue.
    await expect(
      createManualInvoiceAction(prev, form({ discountMode: 'amount', discountValue: '1,500.50' })),
    ).rejects.toThrow('REDIRECT');
    expect(JSON.parse(call()[2].body as string)).toMatchObject({
      discount: { mode: 'amount', value: '1500.50' },
    });

    mocks.apiFetch.mockClear();
    await expect(
      createManualInvoiceAction(prev, form({ discountMode: 'pct', discountValue: '12.5' })),
    ).rejects.toThrow('REDIRECT');
    expect(JSON.parse(call()[2].body as string)).toMatchObject({
      discount: { mode: 'pct', value: '12.5' },
    });
  });

  it('sends no discount for No discount, even with a value left in the field', async () => {
    await expect(
      createManualInvoiceAction(prev, form({ discountMode: 'none', discountValue: '10' })),
    ).rejects.toThrow('REDIRECT');
    expect(JSON.parse(call()[2].body as string)).not.toHaveProperty('discount');
  });

  it('refuses a discount the contract would refuse, before the API', async () => {
    const state = await createManualInvoiceAction(
      prev,
      form({ discountMode: 'pct', discountValue: '120' }),
    );
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.key).toBe(KEY);
    expect(state.errors['discount']).toMatch(/0 to 100/);
  });

  it('refuses a percentage with a space inside and says to remove it, before the API', async () => {
    // Fails on the old code: "1 5" was sent as a 15% discount.
    const state = await createManualInvoiceAction(
      prev,
      form({ discountMode: 'pct', discountValue: '1 5' }),
    );
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors['discount']).toBe('Remove the space inside the number.');
  });

  it('refuses an incomplete form in place and never calls the API, so the key stays unused', async () => {
    const state = await createManualInvoiceAction(
      prev,
      form({ manualReason: ' ', customerId: '' }),
    );
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.key).toBe(KEY);
    expect(state.errors['manualReason']).toBeTruthy();
    expect(state.errors['customerId']).toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('refuses a lines field that is not a list', async () => {
    const state = await createManualInvoiceAction(prev, form({ lines: 'oops' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors['form']).toMatch(/incomplete/i);
  });

  it('keeps the key after a server error, so a landed call cannot create a second invoice', async () => {
    mocks.apiFetch.mockImplementation(() => answer(500, { error: { code: 'boom' } }));
    const state = await createManualInvoiceAction(prev, form());
    expect(state.key).toBe(KEY);
    expect(state.error).toBeTruthy();
  });

  it('keeps the key while the first request with it is still being processed (409)', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409, IN_PROGRESS));
    const state = await createManualInvoiceAction(prev, form());
    expect(state.key).toBe(KEY);
    expect(state.error).toMatch(/still being processed/i);
  });

  it('rotates the key after a final refusal (422) and keeps the form words plain', async () => {
    mocks.apiFetch.mockImplementation(() => answer(422, { error: { code: 'invalid' } }));
    const state = await createManualInvoiceAction(prev, form());
    expect(state.key).not.toBe(KEY);
    expect(state.key).toMatch(UUID);
    expect(state.error).toMatch(/did not accept/i);
  });

  it('names a currency the company switched off when the API refuses it (422)', async () => {
    // The body the API sends today: its error filter does not pass CURRENCY_NOT_ENABLED yet.
    mocks.apiFetch.mockImplementation(() =>
      answer(422, {
        error: {
          code: 'bad_request',
          message: 'Currency INR is not enabled for this company',
          correlationId: 'req-12345678',
        },
      }),
    );
    const state = await createManualInvoiceAction(prev, form({ currency: 'INR' }));
    // Fails on the old code: it said "The platform did not accept this. Check what you entered".
    expect(state.error).toBe(
      'INR is switched off for your company. Choose another currency, or ask an administrator to switch it on in Settings.',
    );
    expect(state.key).not.toBe(KEY);
  });

  it('refuses a currency switched off since the page loaded, before the API', async () => {
    mocks.loadEnabledCurrencies.mockResolvedValue(['NPR', 'USD']);
    const state = await createManualInvoiceAction(prev, form({ currency: 'INR' }));
    // Fails on the old code: no enabled list was passed, so INR went to the API.
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(mocks.loadEnabledCurrencies).toHaveBeenCalledWith({
      accessToken: 't',
      roles: ['accountant'],
    });
    expect(state.key).toBe(KEY);
    expect(state.errors['currency']).toMatch(/Only these currencies are switched on/);
  });

  it('does not forward a key that is not ours', async () => {
    await expect(createManualInvoiceAction(prev, form({ idempotencyKey: 'x y' }))).rejects.toThrow(
      'REDIRECT',
    );
    expect((call()[2].headers as Record<string, string>)['idempotency-key']).toMatch(UUID);
  });

  it('refuses a person without invoice.draft before anything else', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    const state = await createManualInvoiceAction(prev, form());
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.error).toMatch(/do not include/i);
  });

  it('lets a role granted invoice.draft in Settings > Access draft, whatever its defaults', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
    mocks.getMe.mockResolvedValue({ permissions: [{ permission: 'invoice.draft', scope: 'all' }] });
    await expect(createManualInvoiceAction(prev, form())).rejects.toThrow('REDIRECT');
    expect(mocks.getMe).toHaveBeenCalledWith({ accessToken: 't' });
    expect(call()[1]).toBe('/v1/invoices');
  });

  it('falls back to the role defaults only when /v1/me fails', async () => {
    await expect(createManualInvoiceAction(prev, form())).rejects.toThrow('REDIRECT');
    expect(mocks.getMe).toHaveBeenCalled();
    expect(call()[1]).toBe('/v1/invoices');
  });

  it('refuses a role whose invoice.draft was revoked, though its defaults hold it', async () => {
    mocks.getMe.mockResolvedValue({ permissions: [{ permission: 'invoice.read', scope: 'all' }] });
    const state = await createManualInvoiceAction(prev, form());
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.error).toMatch(/do not include/i);
  });
});
