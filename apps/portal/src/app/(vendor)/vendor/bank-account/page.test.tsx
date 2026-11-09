import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sampleOnboarding } from '@/components/vendor/vendor-fixtures';
import { ApiError } from '@/lib/api';

import { Redirect, vendorSession } from '../_upload/test-kit';

const m = vi.hoisted(() => ({ getSession: vi.fn(), getVendorOnboarding: vi.fn() }));

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
vi.mock('@/lib/api.vendor', () => ({ getVendorOnboarding: m.getVendorOnboarding }));

const { default: BankAccountPage } = await import('./page');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async () => renderToStaticMarkup((await BankAccountPage()) as ReactElement);

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.getSession.mockResolvedValue(vendorSession());
  m.getVendorOnboarding.mockResolvedValue(
    sampleOnboarding({ status: 'approved', capability: 'full' }),
  );
});

describe('bank account page', () => {
  it('shows the request form with one key for an approved vendor', async () => {
    const html = await render();
    expect(text(html)).toContain('Bank account');
    expect(html).toContain('name="accountNumber"');
    expect(html).toMatch(/name="idempotencyKey" value="[0-9a-f-]{36}"/);
  });

  it.each(['onboarding_only', 'read_only', 'none'] as const)(
    'shows the no-access notice for a %s account',
    async (capability) => {
      m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability }));
      const html = text(await render());
      expect(html).toContain('Your vendor account cannot use this page');
      expect(html).not.toContain('Request change');
    },
  );

  it('shows the same notice when the API answers 403, and not-found for a 404', async () => {
    m.getVendorOnboarding.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
    m.getVendorOnboarding.mockRejectedValue(new ApiError(404, 'gone'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('sends a visitor without a session to sign in and back', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow(
      'redirect /auth/login?returnTo=%2Fvendor%2Fbank-account',
    );
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });
});
