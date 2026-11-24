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
  brand?: { name: string | null; logoSrc: string | null };
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
const getInboxCount = vi.fn<() => Promise<{ count: number }>>();
const getUnreadCount = vi.fn<() => Promise<{ count: number }>>();
vi.mock('@/lib/api-kernel', () => ({
  getInboxCount: () => getInboxCount(),
  getUnreadCount: () => getUnreadCount(),
}));
vi.mock('@/components/shell/header', () => ({ Header: () => null }));
type CountsProps = { initialInbox?: number; initialNotifications?: number; children: ReactNode };
const countsProps = vi.fn<(props: Omit<CountsProps, 'children'>) => void>();
vi.mock('@/components/shell/shell-counts', () => ({
  ShellCountsProvider: ({ children, ...props }: CountsProps) => {
    countsProps(props);
    return <>{children}</>;
  },
}));
vi.mock('@/components/shell/shell-state', () => ({
  ShellFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ShellMain: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getBranding =
  vi.fn<
    () => Promise<{ displayName: string | null; logo: Record<string, string> | null } | null>
  >();
vi.mock('@/lib/api-branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-branding')>()),
  getBranding: () => getBranding(),
}));
const getMe = vi.fn<
  () => Promise<{
    avatarDocumentId?: string | null;
    displayName?: string | null;
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
  getBranding.mockReset();
  getBranding.mockResolvedValue(null);
  sidebarProps.mockReset();
  countsProps.mockReset();
  getInboxCount.mockReset();
  getInboxCount.mockResolvedValue({ count: 0 });
  getUnreadCount.mockReset();
  getUnreadCount.mockResolvedValue({ count: 2 });
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

  it("leads with the person's name from /v1/me and puts the roles under it", async () => {
    getSession.mockResolvedValue({ ...staff, roles: ['finance', 'sales'] });
    getMe.mockResolvedValue({ avatarDocumentId: PICTURE, displayName: ' Amanda Rai ' });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(lastSidebarUser()).toEqual({
      name: 'Amanda Rai',
      detail: 'Finance, Sales',
      imageDocumentId: PICTURE,
    });
  });

  it('keeps the roles as the name when /v1/me has no name', async () => {
    getSession.mockResolvedValue(staff);
    getMe.mockResolvedValue({ avatarDocumentId: null, displayName: '  ' });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(lastSidebarUser()).toMatchObject({ name: 'Finance', detail: 'staff' });
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
    getInboxCount.mockResolvedValue({ count: 4 });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(sidebarProps).toHaveBeenCalledWith(expect.objectContaining({ counts: { '/inbox': 4 } }));
    // The live poller starts from the same number, and both first-paint counts are read in the layout.
    expect(countsProps).toHaveBeenCalledTimes(1);
    expect(countsProps.mock.calls[0]?.[0]).toEqual({ initialInbox: 4, initialNotifications: 2 });
  });

  it('shows no badge, not a zero, when the read is refused', async () => {
    getSession.mockResolvedValue(staff);
    getInboxCount.mockRejectedValue(new Error('403'));
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(sidebarProps).toHaveBeenCalledWith(expect.objectContaining({ counts: {} }));
    expect(countsProps.mock.calls[0]?.[0].initialInbox).toBeUndefined();
  });

  it('shows a zero count as a zero when the read succeeds', async () => {
    getSession.mockResolvedValue(staff);
    getInboxCount.mockResolvedValue({ count: 0 });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(sidebarProps).toHaveBeenCalledWith(expect.objectContaining({ counts: { '/inbox': 0 } }));
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

// R6Q20: the sidebar's brand lockup gets the company's logo address (the same-origin proxy) and name from the API.
describe('the company logo in the sidebar', () => {
  const lastBrand = () => sidebarProps.mock.calls.at(-1)?.[0].brand;

  it('passes the logo proxy address and the company name', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const documentId = '22222222-2222-4222-8222-222222222222';
    getSession.mockResolvedValue(staff);
    getBranding.mockResolvedValue({ displayName: 'Techrida', logo: { tenantId, documentId } });
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(lastBrand()).toEqual({
      name: 'Techrida',
      logoSrc: `/brand/logo/${tenantId}/${documentId}`,
    });
  });

  it('passes nothing when the branding cannot be read, so the sidebar shows the product name', async () => {
    getSession.mockResolvedValue(staff);
    getBranding.mockResolvedValue(null);
    renderToStaticMarkup((await AppLayout({ children: <p>page</p> })) as ReactElement);
    expect(lastBrand()).toEqual({ name: null, logoSrc: null });
  });
});
