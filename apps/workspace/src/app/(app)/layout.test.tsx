import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

// The vitals receiver needs a session, so the reporter must live only in the signed-in layout.
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('@/components/web-vitals', () => ({ WebVitals: () => <i data-testid="web-vitals" /> }));
const sidebarProps = vi.fn();
vi.mock('@/components/shell/sidebar', () => ({
  Sidebar: (props: unknown) => {
    sidebarProps(props);
    return null;
  },
}));
const getInboxPage = vi.fn<() => Promise<{ items: never[]; total: number }>>();
vi.mock('@/lib/api-kernel', () => ({ getInboxPage: () => getInboxPage() }));
vi.mock('@/components/shell/header', () => ({ Header: () => null }));
vi.mock('@/components/shell/shell-state', () => ({
  ShellFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ShellMain: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('@fontsource-variable/outfit', () => ({}));

const { default: AppLayout } = await import('./layout');
const { default: RootLayout } = await import('../layout');

const staff: Session = {
  id: 'A'.repeat(43),
  sub: 'u1',
  orgId: 'o1',
  orgKind: 'staff',
  roles: ['finance'],
  accessToken: 't',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};

beforeEach(() => {
  getSession.mockReset();
  sidebarProps.mockReset();
  getInboxPage.mockReset();
  getInboxPage.mockResolvedValue({ items: [], total: 0 });
});

describe('web vitals reporter placement', () => {
  it('is not in the root layout, so signed-out pages send no beacons', () => {
    const html = renderToStaticMarkup(RootLayout({ children: <p>login</p> }));
    expect(html).not.toContain('web-vitals');
  });

  it('is in the signed-in app layout', async () => {
    getSession.mockResolvedValue(staff);
    const html = renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(html).toContain('data-testid="web-vitals"');
  });

  it('is never reached without a session', async () => {
    getSession.mockResolvedValue(null);
    await expect(AppLayout({ children: <p>page</p> })).rejects.toThrow('REDIRECT:/auth/login');
  });
});

describe('approvals badge in the sidebar', () => {
  it('passes the waiting count for the inbox link', async () => {
    getSession.mockResolvedValue(staff);
    getInboxPage.mockResolvedValue({ items: [], total: 4 });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(sidebarProps).toHaveBeenCalledWith(
      expect.objectContaining({ counts: { '/inbox': 4 } }),
    );
  });

  it('shows no badge, not a zero, when the read is refused', async () => {
    getSession.mockResolvedValue(staff);
    getInboxPage.mockRejectedValue(new Error('403'));
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(sidebarProps).toHaveBeenCalledWith(expect.objectContaining({ counts: {} }));
  });
});
