import { defaultPortalDisplay } from '@bos/contracts';
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BEFORE_DEADLINE, RFQ_ID, sampleRfq } from '@/components/vendor/rfq-fixtures';
import { sampleOnboarding } from '@/components/vendor/vendor-fixtures';
import { ApiError } from '@/lib/api';

import { callOf, json, Redirect, stubPortalEnv, vendorSession } from '../../../_upload/test-kit';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getVendorOnboarding: vi.fn(),
  getVendorRfq: vi.fn(),
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
  getVendorRfq: m.getVendorRfq,
}));

const { default: QuotePage } = await import('./page');
const { QuoteForm } = await import('./_components/quote-form');

// The portal display goes through the real `getPortalDisplay` and API client; only `fetch` is faked.
const fetchMock = vi.fn<typeof fetch>();
// A frozen display (no `enabledCurrencies`), as an API from before D44 answers.
const DISPLAY = defaultPortalDisplay();

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async (id: string = RFQ_ID, search: { sent?: string } = {}) =>
  renderToStaticMarkup(
    (await QuotePage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve(search),
    })) as ReactElement,
  );

beforeEach(() => {
  // The page compares the sample deadline with now (F1-Q47): pin now before it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BEFORE_DEADLINE);
  for (const f of Object.values(m)) f.mockReset();
  m.getSession.mockResolvedValue(vendorSession());
  m.getVendorOnboarding.mockResolvedValue(
    sampleOnboarding({ status: 'approved', capability: 'full' }),
  );
  m.getVendorRfq.mockResolvedValue(sampleRfq());
  stubPortalEnv();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(json(DISPLAY)));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The `currencies` the page hands the form (the options themselves are tested in the form's test). */
const currenciesOf = async (): Promise<unknown> => {
  const find = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (!isValidElement<{ children?: unknown; currencies?: unknown }>(node)) return undefined;
    if (node.type === QuoteForm) return node.props.currencies;
    return find(node.props.children);
  };
  return find(
    await QuotePage({ params: Promise.resolve({ id: RFQ_ID }), searchParams: Promise.resolve({}) }),
  );
};

describe('submit a quotation page', () => {
  it('shows the request number and its items above the form, with one key and the request id', async () => {
    const html = await render();
    expect(text(html)).toContain('RFQ-2082-0012');
    expect(text(html)).toContain('Cat6 patch cable, 3 m, shielded');
    expect(html).toContain('name="total"');
    expect(html).toContain('name="vendorRef"');
    expect(html).toContain('name="validUntil"');
    expect(html).toContain('name="deliveryDays"');
    expect(html).toMatch(/name="idempotencyKey" value="[0-9a-f-]{36}"/);
    expect(html).toContain(`name="rfqId" value="${RFQ_ID}"`);
    expect(html).not.toContain('name="documentId"');
    expect(html).toContain(`href="/vendor/rfqs/${RFQ_ID}"`);
    expect(m.getVendorRfq).toHaveBeenCalledWith(expect.anything(), RFQ_ID);
  });

  it('answers a bad id with not-found before any call', async () => {
    await expect(render('not-an-id')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(m.getSession).not.toHaveBeenCalled();
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
    expect(m.getVendorRfq).not.toHaveBeenCalled();
  });

  it('answers a 404 on the request with not-found', async () => {
    m.getVendorRfq.mockRejectedValue(new ApiError(404, 'gone'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it.each(['onboarding_only', 'read_only', 'none'] as const)(
    'shows the no-access notice for a %s account, before the request is read',
    async (capability) => {
      m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability }));
      const html = text(await render());
      expect(html).toContain('Your vendor account cannot use this page');
      expect(html).not.toContain('name="total"');
      expect(m.getVendorRfq).not.toHaveBeenCalled();
    },
  );

  it('shows the same notice when the API answers 403, on either call', async () => {
    m.getVendorOnboarding.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
    expect(m.getVendorRfq).not.toHaveBeenCalled();
    m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability: 'full' }));
    m.getVendorRfq.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
  });

  it('after the deadline says it passed and shows no form (F1-Q47)', async () => {
    m.getVendorRfq.mockResolvedValue(sampleRfq({ deadline: '2020-01-01T00:00:00.000Z' }));
    const html = await render();
    expect(text(html)).toContain('The deadline for this request has passed');
    expect(text(html)).toContain('We can no longer take a quotation for this request.');
    expect(text(html)).not.toContain('You can still try to send one');
    expect(html).not.toContain('name="total"');
  });

  it('shows the form while the deadline is ahead', async () => {
    m.getVendorRfq.mockResolvedValue(sampleRfq({ deadline: '2999-01-01T00:00:00.000Z' }));
    const html = await render();
    expect(html).toContain('name="total"');
    expect(html).not.toContain('disabled=""');
  });

  it('shows no warning while the deadline is ahead', async () => {
    m.getVendorRfq.mockResolvedValue(sampleRfq({ deadline: '2999-01-01T00:00:00.000Z' }));
    expect(text(await render())).not.toContain('deadline for this request has passed');
  });

  it('shows the success alert after sending', async () => {
    expect(text(await render(RFQ_ID, { sent: '1' }))).toContain('We received your quotation');
    expect(text(await render())).not.toContain('We received your quotation');
  });

  it('sends a visitor without a session to sign in and back', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow(
      `redirect /auth/login?returnTo=${encodeURIComponent(`/vendor/rfqs/${RFQ_ID}/quote`)}`,
    );
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });

  it('hands the form only the currencies the company switched on, read with the vendor session', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(json({ ...DISPLAY, enabledCurrencies: ['NPR', 'USD'] })),
    );
    expect(await currenciesOf()).toEqual(['NPR', 'USD']);
    expect(await render()).toContain('name="currency" value="NPR"');
    const displayCall = fetchMock.mock.calls.findIndex((_, n) =>
      callOf(fetchMock, n).url.endsWith('/v1/portal/display'),
    );
    expect(displayCall).toBeGreaterThanOrEqual(0);
    expect(callOf(fetchMock, displayCall).headers.get('authorization')).toBe(
      `Bearer ${vendorSession().accessToken}`,
    );
  });

  it('hands the form every currency when the display has no list, or cannot be read', async () => {
    expect(await currenciesOf()).toEqual(['NPR', 'INR', 'USD']);
    fetchMock.mockImplementation(() => Promise.resolve(json({ error: {} }, 503)));
    expect(await currenciesOf()).toEqual(['NPR', 'INR', 'USD']);
  });
});
