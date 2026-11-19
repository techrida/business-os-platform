import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callOf, ID, json, session, stubPortalEnv } from '@/lib/billing-test-support';
import type { Session } from '@/lib/session';

import { sampleInvoice, sampleSettlement } from '../_components/invoice-fixtures';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
class NotFound extends Error {}
class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound('not found');
  },
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const { default: InvoicePage } = await import('./page');

const fetchMock = vi.fn<typeof fetch>();

/**
 * The invoice call answers with `invoice`, the settlement call with `settlement`, and the display
 * setting call with `display` (a 404 by default, so the page falls back to the defaults).
 */
function api(
  invoice: () => Response,
  settlement: () => Response,
  display: () => Response = () => json({ error: { code: 'not_found' } }, 404),
) {
  fetchMock.mockImplementation((url) => {
    const path = (url as URL | string).toString();
    if (path.endsWith('/v1/portal/display')) return Promise.resolve(display());
    return Promise.resolve(path.endsWith('/settlement') ? settlement() : invoice());
  });
}

const render = (id = ID) => InvoicePage({ params: Promise.resolve({ id }) });

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(session);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('invoice page', () => {
  it('shows the invoice with the server settlement and a way to pay', async () => {
    api(
      () => json(sampleInvoice()),
      () => json(sampleSettlement({ settlement: 'partly_paid', openAmount: '1000000.00' })),
    );
    const html = renderToStaticMarkup(await render());
    expect(html).toContain('INV-2083/84-00001');
    expect(html).toContain('Partly paid');
    expect(html).toContain('NPR 10,00,000.00');
    expect(html).toContain(`/payments/new?invoice=${ID}`);
    const urls = fetchMock.mock.calls.map((_, i) => callOf(fetchMock, i).url);
    expect(urls.some((u) => u.includes(`/v1/portal/invoices/${ID}`))).toBe(true);
  });

  it('draws amounts with the number system the company chose', async () => {
    api(
      () => json(sampleInvoice()),
      () => json(sampleSettlement({ settlement: 'partly_paid', openAmount: '1000000.00' })),
      () =>
        json({
          numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
          dateFormat: 'dd/MM/yyyy',
        }),
    );
    const html = renderToStaticMarkup(await render());
    expect(html).toContain('NPR 1,000,000.00');
    expect(html).not.toContain('NPR 10,00,000.00');
  });

  it('shows the same not-found for a 404, a 403, a junk id and a draft-shaped body', async () => {
    const outcomes: Array<() => Promise<unknown>> = [
      () => {
        api(
          () => json({ error: { code: 'not_found' } }, 404),
          () => json({ error: { code: 'not_found' } }, 404),
        );
        return render();
      },
      () => {
        api(
          () => json({ error: { code: 'forbidden' } }, 403),
          () => json({ error: { code: 'forbidden' } }, 403),
        );
        return render();
      },
      () => {
        api(
          () => json(sampleInvoice()),
          () => json({ error: { code: 'not_found' } }, 404),
        );
        return render();
      },
      () => {
        api(
          () => json({ ...sampleInvoice(), number: null }),
          () => json(sampleSettlement()),
        );
        return render();
      },
      () => render('../admin'),
    ];
    for (const run of outcomes) {
      await expect(run()).rejects.toBeInstanceOf(NotFound);
    }
  });

  it('keeps the invoice and says the status is unavailable when only the settlement fails', async () => {
    api(
      () => json(sampleInvoice()),
      () => new Response('down', { status: 503 }),
    );
    const html = renderToStaticMarkup(await render());
    expect(html).toContain('INV-2083/84-00001');
    expect(html).toContain('could not load the payment status');
    expect(html).not.toContain('Submit a payment');
  });

  it('lets a failing invoice read reach the error page, and sends a signed-out user to sign in', async () => {
    api(
      () => new Response('down', { status: 503 }),
      () => json(sampleSettlement()),
    );
    await expect(render()).rejects.toThrow('503');
    api(
      () => json({}, 401),
      () => json({}, 401),
    );
    await expect(render()).rejects.toMatchObject({
      to: `/auth/login?returnTo=${encodeURIComponent(`/invoices/${ID}`)}`,
    });
    getSession.mockResolvedValue(null);
    await expect(render()).rejects.toBeInstanceOf(Redirect);
  });
});
