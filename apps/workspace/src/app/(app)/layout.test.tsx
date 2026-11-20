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
type SidebarProps = {
  user: Record<string, unknown>;
  permissions: readonly string[];
  counts?: Record<string, number>;
};
const sidebarProps = vi.fn<(props: SidebarProps) => void>();
vi.mock('@/components/shell/sidebar', () => ({
  Sidebar: (props: SidebarProps) => {
    sidebarProps(props);
    return null;
  },
}));
const lastSidebarUser = () => sidebarProps.mock.calls.at(-1)?.[0].user;
const getInboxPage = vi.fn<() => Promise<{ items: never[]; total: number }>>();
vi.mock('@/lib/api-kernel', () => ({ getInboxPage: () => getInboxPage() }));
vi.mock('@/components/shell/header', () => ({ Header: () => null }));
vi.mock('@/components/shell/shell-state', () => ({
  ShellFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ShellMain: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe = vi.fn<
  () => Promise<{
    avatarDocumentId?: string | null;
    permissions?: { permission: string; scope: string }[];
  }>
>();
vi.mock('@/lib/api', () => ({ getMe: () => getMe() }));
vi.mock('@/lib/display-settings', async () => {
  const { DEFAULT_NUMBER_SYSTEMS } = await import('@bos/locale');
  return { getNumberSystems: () => Promise.resolve(DEFAULT_NUMBER_SYSTEMS) };
});
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

const PICTURE = '00000000-0000-4000-8000-0000000000aa';

beforeEach(() => {
  getSession.mockReset();
  getMe.mockReset();
  getMe.mockResolvedValue({ avatarDocumentId: null });
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

describe('the account picture in the sidebar', () => {
  it('comes from /v1/me, keeping the roles as the name', async () => {
    getSession.mockResolvedValue(staff);
    getMe.mockResolvedValue({ avatarDocumentId: PICTURE });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(lastSidebarUser()).toEqual({
      name: 'Finance',
      detail: 'staff',
      imageDocumentId: PICTURE,
    });
  });

  it('falls back to initials when /v1/me fails, and the shell still renders', async () => {
    getSession.mockResolvedValue(staff);
    getMe.mockRejectedValue(new Error('upstream down'));
    const html = renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(html).toContain('<p>page</p>');
    expect(lastSidebarUser()).toMatchObject({ imageDocumentId: null });
  });

  it('still redirects a signed-out visitor before asking /v1/me', async () => {
    getSession.mockResolvedValue(null);
    await expect(AppLayout({ children: <p>page</p> })).rejects.toThrow('REDIRECT:/auth/login');
    expect(getMe).not.toHaveBeenCalled();
  });
});

describe('approvals badge in the sidebar', () => {
  it('passes the waiting count for the inbox link', async () => {
    getSession.mockResolvedValue(staff);
    getInboxPage.mockResolvedValue({ items: [], total: 4 });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(sidebarProps).toHaveBeenCalledWith(expect.objectContaining({ counts: { '/inbox': 4 } }));
  });

  it('shows no badge, not a zero, when the read is refused', async () => {
    getSession.mockResolvedValue(staff);
    getInboxPage.mockRejectedValue(new Error('403'));
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(sidebarProps).toHaveBeenCalledWith(expect.objectContaining({ counts: {} }));
  });
});

describe('navigation grants in the sidebar', () => {
  const lastPermissions = () => sidebarProps.mock.calls.at(-1)?.[0].permissions;

  it('are the live grants from /v1/me, including one Settings > Access added to the role', async () => {
    getSession.mockResolvedValue(staff);
    getMe.mockResolvedValue({
      permissions: [
        { permission: 'admin.users.read', scope: 'all' },
        { permission: 'invoice.read', scope: 'own' },
      ],
    });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(lastPermissions()).toEqual(['admin.users.read', 'invoice.read']);
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it('fall back to the role defaults when /v1/me fails', async () => {
    const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
    getSession.mockResolvedValue(staff);
    getMe.mockRejectedValue(new Error('upstream down'));
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect([...(lastPermissions() ?? [])].sort()).toEqual(
      Object.keys(DEFAULT_ROLE_PERMISSIONS.finance).sort(),
    );
  });
});
