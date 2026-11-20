import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BEFORE_DEADLINE, RFQ_ID, sampleRfq } from '@/components/vendor/rfq-fixtures';
import { sampleOnboarding } from '@/components/vendor/vendor-fixtures';
import { ApiError } from '@/lib/api';

import { Redirect, vendorSession } from '../../_upload/test-kit';

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
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api.vendor', () => ({
  getVendorOnboarding: m.getVendorOnboarding,
  getVendorRfq: m.getVendorRfq,
}));

const { default: RfqPage } = await import('./page');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async (id: string = RFQ_ID) =>
  renderToStaticMarkup((await RfqPage({ params: Promise.resolve({ id }) })) as ReactElement);

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
});

afterEach(() => {
  vi.useRealTimers();
});

describe('vendor RFQ detail page', () => {
  it('shows the RFQ, a way back and the quotation link', async () => {
    const html = await render();
    expect(text(html)).toContain('RFQ-2082-0012');
    expect(text(html)).toContain('Nepal time');
    expect(html).toContain('href="/vendor/rfqs"');
    expect(html).toContain(`href="/vendor/rfqs/${RFQ_ID}/quote"`);
    expect(m.getVendorRfq).toHaveBeenCalledWith(expect.anything(), RFQ_ID);
  });

  it('after the deadline says it passed and drops the quotation link (F1-Q47)', async () => {
    m.getVendorRfq.mockResolvedValue(sampleRfq({ deadline: '2020-01-01T00:00:00.000Z' }));
    const html = await render();
    expect(text(html)).toContain('The deadline for this request has passed');
    expect(text(html)).toContain('If we extend the deadline, the new date will show here.');
    expect(html).not.toContain(`href="/vendor/rfqs/${RFQ_ID}/quote"`);
  });

  it.each(['not-a-uuid', '../bills', '123'])(
    'answers a bad id (%s) with not-found before any API call',
    async (id) => {
      await expect(render(id)).rejects.toThrow('NEXT_NOT_FOUND');
      expect(m.getSession).not.toHaveBeenCalled();
      expect(m.getVendorOnboarding).not.toHaveBeenCalled();
      expect(m.getVendorRfq).not.toHaveBeenCalled();
    },
  );

  it('answers every 404 with the same not-found', async () => {
    m.getVendorRfq.mockRejectedValue(new ApiError(404, 'gone'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    m.getVendorOnboarding.mockRejectedValue(new ApiError(404, 'gone'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it.each(['onboarding_only', 'read_only', 'none'] as const)(
    'shows the no-access notice for a %s account, before the RFQ is read',
    async (capability) => {
      m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability }));
      const html = text(await render());
      expect(html).toContain('Your vendor account cannot use this page');
      expect(html).not.toContain('RFQ-2082-0012');
      expect(m.getVendorRfq).not.toHaveBeenCalled();
    },
  );

  it('shows the same notice when the API answers 403', async () => {
    m.getVendorOnboarding.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
    m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability: 'full' }));
    m.getVendorRfq.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
  });

  it('sends a visitor without a session to sign in and back to the same RFQ', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow(
      `redirect /auth/login?returnTo=${encodeURIComponent(`/vendor/rfqs/${RFQ_ID}`)}`,
    );
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });
});
