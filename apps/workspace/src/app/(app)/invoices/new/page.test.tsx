// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOMER_LIST_MAX_LIMIT } from '@bos/contracts';
import { ApiError } from '@/lib/api';
import { click, fill, mountForm } from '@/test/form-interactions';

import { ManualInvoiceForm } from './manual-invoice-form';
import NewInvoicePage from './page';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ listCustomers: vi.fn(), call: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ accessToken: 'test-token', roles: ['accountant'] }),
}));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));
vi.mock('@/lib/api-tax-codes', () => ({ listTaxCodes: () => Promise.resolve([]) }));
// The real `loadEnabledCurrencies` reads `GET /v1/settings/display` through this client.
vi.mock('@/lib/api-procurement', () => ({ call: mocks.call }));
vi.mock('./actions', () => ({ createManualInvoiceAction: vi.fn() }));
// GET /v1/me for an unedited role answers the role's default grants.
vi.mock('@/lib/live-permissions', async () => {
  const { permissionChecker } = await import('@/components/p2/customers/permissions');
  return {
    getPermissionCheck: (s: { roles: string[] }) => Promise.resolve(permissionChecker(s.roles)),
  };
});

const customerPage = {
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      legalName: 'Invoice customer',
      number: 'CUS-001',
      defaultCurrency: 'NPR',
      mergedIntoId: null,
    },
  ],
  total: 1,
};

beforeEach(() => {
  mocks.listCustomers.mockReset().mockResolvedValue(customerPage);
  mocks.call
    .mockReset()
    .mockImplementation((_session, path: string) =>
      path === '/v1/settings/display'
        ? Promise.resolve({ enabledCurrencies: ['NPR', 'INR', 'USD'] })
        : Promise.reject(new ApiError(404, 'Not found')),
    );
});

/** The currency Select's choices: the options of the hidden native select after its named input. */
const currencyOptions = (html: string): string[] => {
  const after = html.slice(html.lastIndexOf('name="currency"'));
  const select = /<select[^>]*>(.*?)<\/select>/s.exec(after)?.[1] ?? '';
  return [...select.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1] ?? '');
};

it('loads the manual invoice picker using a query accepted by the real customer API', async () => {
  mocks.listCustomers.mockImplementation((_session, query: { limit: number }) => {
    // Hold the page's actual request to the API's shared page-size limit (the API schema and
    // its tests use the same contract constant). A permissive list mock previously hid the
    // rejected 200-customer request. The workspace must not import API source: the workspace
    // image installs only its own dependencies and type-checks this file during `next build`.
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > CUSTOMER_LIST_MAX_LIMIT
    ) {
      return Promise.reject(new ApiError(400, 'Invalid customer page size'));
    }
    return Promise.resolve(customerPage);
  });

  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(html).toContain('Save draft invoice');
  // The customer box is one combobox; its options (name, then number and PAN) show only while it is open.
  expect(html).toContain('role="combobox"');
  expect(html).toContain('<input type="hidden" name="customerId" value=""');
  expect(html).not.toContain('The customers did not load');
});

it('offers only the currencies the company has switched on', async () => {
  mocks.call.mockResolvedValue({ enabledCurrencies: ['NPR', 'USD'] });

  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(currencyOptions(html)).toEqual(['NPR', 'USD']);
  expect(html).not.toContain('INR (Indian rupee)');
});

it('offers the default list when the display settings cannot be read', async () => {
  mocks.call.mockRejectedValue(new ApiError(503, 'Unavailable'));

  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(currencyOptions(html)).toEqual(['NPR', 'INR', 'USD']);
  expect(html).toContain('Save draft invoice');
});

it('draws the Figma card eyebrows as decoration and one column header row for the lines', async () => {
  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(html).toMatch(
    /<span[^>]*aria-hidden="true"[^>]*>01 · The basics<\/span>Customer and source/,
  );
  expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>02 · The story<\/span>Line Items/);
  // The header row is hidden from assistive technology; each input keeps its own label.
  expect(html).toMatch(/<div[^>]*aria-hidden="true"[^>]*><span>#<\/span>/);
  // Once in the header row, once as line 1's own label.
  expect(html.match(/Unit price \(NPR\)/g)).toHaveLength(2);
});

it('offers an optional document discount, none by default', async () => {
  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(html).toContain('name="discountMode"');
  expect(html).toContain('value="none"');
  expect(html).toContain('Discount %');
  expect(html).toContain('Discount amount (NPR)');
  // No value is posted until one of the two boxes is typed in.
  expect(html).not.toContain('name="discountValue"');
});

describe('the form in a browser', () => {
  let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const mount = async (today?: string) => {
    mounted = await mountForm(
      <ManualInvoiceForm
        action={vi.fn()}
        customers={[{ id: customerPage.items[0]!.id, label: 'Invoice customer', currency: 'NPR' }]}
        taxCodes={[]}
        enabledCurrencies={['NPR', 'INR', 'USD']}
        idempotencyKey="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        {...(today ? { today } : {})}
      />,
    );
    return mounted.container;
  };

  /** The visible box `Field` labels with `label`. */
  const box = (container: HTMLElement, label: string) => {
    const id = Array.from(container.querySelectorAll('label[for]'))
      .find((l) => l.textContent?.trim().startsWith(label))
      ?.getAttribute('for');
    return id ? container.querySelector<HTMLInputElement>(`input[id="${id}"]`) : null;
  };
  const posted = (container: HTMLElement) =>
    new FormData(container.querySelector('form')!).get('discountValue');

  it('offers no due date before today in Kathmandu', async () => {
    // Fails on the old code: the due-date picker had no minimum, so a past date could be chosen.
    // 21:00 UTC on the 14th is already the 15th in Kathmandu (UTC+5:45). The page passes no date, so the
    // form's own today is the one under test. Only Date is faked; the inputs' timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T21:00:00Z'));
    const container = await mount();
    await click(container.querySelector('button[aria-label="Calendar"]'));
    const disabled = (day: string) =>
      Array.from(document.querySelectorAll('[role="gridcell"]')).some(
        (c) => c.textContent?.trim() === day && c.querySelector('[aria-disabled="true"]') !== null,
      );
    expect(disabled('14')).toBe(true);
    expect(disabled('15')).toBe(false);
    expect(disabled('16')).toBe(false);
  });

  it('groups a fixed amount as the currency does and posts the plain number', async () => {
    // Fails on the old code: a plain text box showed 1250000 as typed.
    const container = await mount();
    const amount = box(container, 'Discount amount (NPR)');
    await fill(amount, '1250000');
    expect(amount?.value).toBe('12,50,000');
    expect(posted(container)).toBe('1250000');
  });

  it('takes a percentage in a percent box', async () => {
    const container = await mount();
    const percent = box(container, 'Discount %');
    expect(percent?.getAttribute('role')).toBe('spinbutton');
    await fill(percent, '12.5');
    expect(posted(container)).toBe('12.5');
  });
});
