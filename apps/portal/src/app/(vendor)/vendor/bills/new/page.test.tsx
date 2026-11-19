import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sampleOnboarding, samplePoListItem } from '@/components/vendor/vendor-fixtures';
import { ApiError } from '@/lib/api';

import { PO, Redirect, vendorSession } from '../../_upload/test-kit';

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

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async (search: { po?: string; sent?: string } = {}) =>
  renderToStaticMarkup(
    (await NewBillPage({ searchParams: Promise.resolve(search) })) as ReactElement,
  );

beforeEach(() => {
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

  it('sends a visitor without a session to sign in and back', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('redirect /auth/login?returnTo=%2Fvendor%2Fbills%2Fnew');
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });
});
