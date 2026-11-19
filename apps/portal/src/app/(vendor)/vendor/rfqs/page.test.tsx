import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RFQ_ID, sampleRfqListItem } from '@/components/vendor/rfq-fixtures';
import { sampleOnboarding } from '@/components/vendor/vendor-fixtures';
import { ApiError } from '@/lib/api';

import { Redirect, vendorSession } from '../_upload/test-kit';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getVendorOnboarding: vi.fn(),
  listVendorRfqs: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  // The list's filter bar is a client component and reads these.
  usePathname: () => '/vendor/rfqs',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api.vendor', () => ({
  getVendorOnboarding: m.getVendorOnboarding,
  listVendorRfqs: m.listVendorRfqs,
}));

const { default: RfqsPage } = await import('./page');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async (params: Record<string, string | string[]> = {}) =>
  renderToStaticMarkup((await RfqsPage({ searchParams: Promise.resolve(params) })) as ReactElement);

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.getSession.mockResolvedValue(vendorSession());
  m.getVendorOnboarding.mockResolvedValue(
    sampleOnboarding({ status: 'approved', capability: 'full' }),
  );
  m.listVendorRfqs.mockResolvedValue([sampleRfqListItem()]);
});

describe('vendor RFQ list page', () => {
  it('lists the RFQs for a full vendor account', async () => {
    const html = await render();
    expect(text(html)).toContain('Requests for quotation');
    expect(text(html)).toContain('RFQ-2082-0012');
    expect(html).toContain(`href="/vendor/rfqs/${RFQ_ID}"`);
  });

  it('shows the empty state when there are none', async () => {
    m.listVendorRfqs.mockResolvedValue([]);
    expect(text(await render())).toContain('No requests for quotation yet');
  });

  it.each(['onboarding_only', 'read_only', 'none'] as const)(
    'shows the no-access notice for a %s account, before the list is read',
    async (capability) => {
      m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability }));
      const html = text(await render());
      expect(html).toContain('Your vendor account cannot use this page');
      expect(html).not.toContain('Requests for quotation');
      expect(m.listVendorRfqs).not.toHaveBeenCalled();
    },
  );

  it('shows the same notice when the API answers 403, and not-found for a 404', async () => {
    m.getVendorOnboarding.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
    m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability: 'full' }));
    m.listVendorRfqs.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
    m.listVendorRfqs.mockRejectedValue(new ApiError(404, 'gone'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('lets any other failure reach the error page', async () => {
    m.listVendorRfqs.mockRejectedValue(new ApiError(502, 'bad body'));
    await expect(render()).rejects.toThrow('bad body');
  });

  it('sends a visitor without a session to sign in and back', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('redirect /auth/login?returnTo=%2Fvendor%2Frfqs');
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });
});
