import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sampleOnboarding, samplePoListItem } from '@/components/vendor/vendor-fixtures';
import { ApiError } from '@/lib/api';
import { DEFAULT_PORTAL_DISPLAY } from '@/lib/display';

import { callOf, json, PO, Redirect, stubPortalEnv, vendorSession } from '../../_upload/test-kit';

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

// The display read is the real one (`getPortalDisplay` -> `GET /v1/portal/display`), answered here.
const fetchMock = vi.fn<typeof fetch>();
const DISPLAY_URL = 'http://api:3001/v1/portal/display';
const answerDisplay = (enabledCurrencies: readonly string[]) =>
  fetchMock.mockImplementation((url) =>
    Promise.resolve(
      (url instanceof URL ? url.href : typeof url === 'string' ? url : url.url) === DISPLAY_URL
        ? json({ ...DEFAULT_PORTAL_DISPLAY, enabledCurrencies })
        : json({ error: { code: 'not_found' } }, 404),
    ),
  );

/** The currency Select's choices: the options of the hidden native select after its named input. */
const currencyChoices = (html: string): string[] => {
  const after = html.slice(html.indexOf('name="currency"'));
  const select = /<select[^>]*>(.*?)<\/select>/s.exec(after)?.[1] ?? '';
  return [...select.matchAll(/<option[^>]*value="([^"]+)"/g)].map((x) => x[1] ?? '');
};

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async (search: { po?: string; sent?: string } = {}) =>
  renderToStaticMarkup(
    (await NewBillPage({ searchParams: Promise.resolve(search) })) as ReactElement,
  );

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  answerDisplay(['NPR', 'INR', 'USD']);
  for (const f of Object.values(m)) f.mockReset();
  m.getSession.mockResolvedValue(vendorSession());
  m.getVendorOnboarding.mockResolvedValue(
    sampleOnboarding({ status: 'approved', capability: 'full' }),
  );
  m.listVendorPurchaseOrders.mockResolvedValue([
    samplePoListItem({ id: PO, number: 'PO-2082-0007' }),
    samplePoListItem({
      id: '11111111-1111-4111-8111-111111111111',
      number: 'PO-OLD',
      status: 'closed',
    }),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('submit a bill page', () => {
  it('shows the form with the vendor’s open orders and one key', async () => {
    const html = await render();
    expect(html).toContain('Submit a bill');
    expect(html).toContain('name="vendorInvoiceNo"');
    expect(html).toContain('name="claimedTotal"');
    expect(html).toContain('PO-2082-0007');
    expect(html).not.toContain('PO-OLD');
    expect(html).toMatch(/name="idempotencyKey" value="[0-9a-f-]{36}"/);
    expect(html).not.toContain('name="documentId"');
  });

  it.each(['onboarding_only', 'read_only', 'none'] as const)(
    'shows the no-access notice for a %s account, before any other API call',
    async (capability) => {
      m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability }));
      const html = text(await render());
      expect(html).toContain('Your vendor account cannot use this page');
      expect(html).not.toContain('Submit a bill');
      expect(m.listVendorPurchaseOrders).not.toHaveBeenCalled();
    },
  );

  it('shows the same notice when the API answers 403', async () => {
    m.getVendorOnboarding.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
    m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability: 'full' }));
    m.listVendorPurchaseOrders.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
  });

  it('preselects an order from ?po= only when it is the vendor’s own, and says what happens after sending', async () => {
    // The Select submits through its hidden field; its trigger shows the chosen label.
    const own = await render({ po: PO });
    expect(own).toContain(`<input type="hidden" name="purchaseOrderId" value="${PO}"/>`);
    const foreign = await render({ po: '22222222-2222-4222-8222-222222222222' });
    expect(foreign).toContain('<input type="hidden" name="purchaseOrderId" value=""/>');
    expect(foreign).toContain('Not linked to an order</span>');
    expect(foreign).not.toContain('22222222-2222');
    const sent = text(await render({ sent: '1' }));
    expect(sent).toContain('We received your bill');
    expect(sent).toContain('once we have entered it');
  });

  it('offers only the currencies the company has switched on, read once from the display', async () => {
    answerDisplay(['NPR', 'USD']);
    const html = await render();
    const displayReads = fetchMock.mock.calls.filter(
      (_, n) => callOf(fetchMock, n).url === DISPLAY_URL,
    );
    expect(displayReads).toHaveLength(1);
    expect(currencyChoices(html)).toEqual(['NPR', 'USD']);
    expect(html).toContain('<input type="hidden" name="currency" value="NPR"/>');
  });

  it('offers the default list when the display cannot be read', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ error: {} }, 503)));
    const html = await render();
    expect(currencyChoices(html)).toEqual(['NPR', 'INR', 'USD']);
    expect(html).toContain('name="vendorInvoiceNo"');
  });

  it('sends a visitor without a session to sign in and back', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('redirect /auth/login?returnTo=%2Fvendor%2Fbills%2Fnew');
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });
});
