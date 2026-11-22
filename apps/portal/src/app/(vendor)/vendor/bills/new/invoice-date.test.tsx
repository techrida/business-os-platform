// TR-Q12a (R2-011): the vendor portal's bill form starts with the invoice date set to today in Kathmandu, as the
// staff bill form does (I-34), and the field stays editable. Renders the real page, collects what the form would
// submit, and sends that payload through the real server action to the API (stubbed fetch).
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sampleOnboarding, samplePoListItem } from '@/components/vendor/vendor-fixtures';
import { DEFAULT_PORTAL_DISPLAY } from '@/lib/display';

import {
  callOf,
  DOC,
  json,
  PO,
  Redirect,
  redirectOf,
  stubPortalEnv,
  vendorSession,
} from '../../_upload/test-kit';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getVendorOnboarding: vi.fn(),
  listVendorPurchaseOrders: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api.vendor', () => ({
  getVendorOnboarding: m.getVendorOnboarding,
  listVendorPurchaseOrders: m.listVendorPurchaseOrders,
}));

const { default: NewBillPage } = await import('./page');
const { submitBillAction } = await import('./actions');

const DISPLAY_URL = 'http://api:3001/v1/portal/display';
const SUBMIT_URL = 'http://api:3001/v1/portal/vendor/bill-submissions';
const fetchMock = vi.fn<typeof fetch>();
const urlOf = (u: Parameters<typeof fetch>[0]) =>
  u instanceof URL ? u.href : typeof u === 'string' ? u : u.url;

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url) =>
    Promise.resolve(
      urlOf(url) === DISPLAY_URL
        ? json({ ...DEFAULT_PORTAL_DISPLAY, enabledCurrencies: ['NPR'] })
        : urlOf(url) === SUBMIT_URL
          ? json({ status: 'received' }, 201)
          : json({ error: { code: 'not_found' } }, 404),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  for (const f of Object.values(m)) f.mockReset();
  m.getSession.mockResolvedValue(vendorSession());
  m.getVendorOnboarding.mockResolvedValue(
    sampleOnboarding({ status: 'approved', capability: 'full' }),
  );
  m.listVendorPurchaseOrders.mockResolvedValue([samplePoListItem({ id: PO })]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const render = async () =>
  renderToStaticMarkup((await NewBillPage({ searchParams: Promise.resolve({}) })) as ReactElement);

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The rendered invoice date input. */
const invoiceDateInput = (html: string) =>
  /<input[^>]*name="invoiceDate"[^>]*>/.exec(html)?.[0] ?? '';

/** What the browser would submit from the rendered markup: every named input with its value. */
function formOf(html: string): FormData {
  const form = new FormData();
  for (const [tag] of html.matchAll(/<input[^>]*>/g)) {
    const name = attr(tag, 'name');
    if (name !== undefined) form.set(name, attr(tag, 'value') ?? '');
  }
  return form;
}

describe('portal bill invoice date default (TR-Q12a)', () => {
  it("starts at today's date in Kathmandu, also when it is already tomorrow there", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 20:00 UTC on 19 Nov is 01:45 on 20 Nov in Kathmandu.
    vi.setSystemTime(new Date('2026-11-19T20:00:00Z'));
    const input = invoiceDateInput(await render());
    expect(attr(input, 'value')).toBe('2026-11-20');
    // The not-after-today limit lives in the DatePicker; bill-form.test.tsx types a later date.
    expect(input).not.toMatch(/type="date"/);
  });

  it('stays editable: the field is neither read-only nor disabled', async () => {
    const input = invoiceDateInput(await render());
    expect(input).not.toBe('');
    expect(input).not.toMatch(/readonly|disabled/i);
  });

  it('sends the default date to the API when the vendor leaves it as it is', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T20:00:00Z'));
    const form = formOf(await render());
    // What the vendor does in the browser: upload the file, type the number and the total. The date is untouched.
    form.set('documentId', DOC);
    form.set('vendorInvoiceNo', 'INV-77');
    form.set('claimedTotal', '1,000.00');
    expect(form.get('invoiceDate')).toBe('2026-11-20');

    const key = form.get('idempotencyKey');
    if (typeof key !== 'string') throw new Error('the form has no idempotency key');
    expect(await redirectOf(submitBillAction({ key }, form))).toBe('/vendor/bills/new?sent=1');
    const sent = fetchMock.mock.calls
      .map((_, n) => callOf(fetchMock, n))
      .find((c) => c.url === SUBMIT_URL);
    expect(sent?.body).toMatchObject({ invoiceDate: '2026-11-20', vendorInvoiceNo: 'INV-77' });
  });
});
