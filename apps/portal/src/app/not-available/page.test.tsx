import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: (to: string) => m.redirect(to) }));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));

const { default: NotAvailablePage } = await import('./page');

beforeEach(() => {
  m.getSession.mockReset();
  m.redirect.mockClear();
});

// Sign-in reaches this page only for an organisation kind that is neither customer nor vendor.
describe('/not-available', () => {
  it('says the account is not served, offers sign out, and promises no supplier portal', async () => {
    m.getSession.mockResolvedValue(null);
    const html = renderToStaticMarkup((await NotAvailablePage()) as ReactElement);
    expect(html).toContain('This portal is not available for your account');
    expect(html).toContain('customers and vendors');
    expect(html).toContain('action="/auth/logout"');
    expect(html).not.toMatch(/not available yet|suppliers/i);
  });

  it('sends anyone who has a session to /', async () => {
    m.getSession.mockResolvedValue({ orgKind: 'customer' });
    await expect(NotAvailablePage()).rejects.toThrow('NEXT_REDIRECT /');
  });
});
