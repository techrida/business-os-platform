// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const seen = vi.hoisted(() => ({
  avatars: [] as Array<Record<string, unknown>>,
  avatarMounts: 0,
  uploads: [] as Array<Record<string, unknown>>,
  refresh: vi.fn(),
  navGroups: [] as Array<{ label: string; items: Array<{ label: string }> }>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: seen.refresh }) }));
vi.mock('@/components/ui/avatar', async () => {
  const { useEffect } = await import('react');
  return {
    Avatar: (props: Record<string, unknown>) => {
      seen.avatars.push(props);
      useEffect(() => {
        seen.avatarMounts += 1;
      }, []);
      return <span data-testid="avatar" />;
    },
  };
});
vi.mock('@/components/ui/image-upload', () => ({
  ImageUpload: (props: Record<string, unknown>) => {
    seen.uploads.push(props);
    return <div data-testid="image-upload" />;
  },
}));
// The navigation and shell controls have their own tests; here they only need to stay out of the way.
vi.mock('./brand', () => ({ Brand: () => null }));
vi.mock('./shell-nav', () => ({
  ShellNav: ({ groups }: { groups: typeof seen.navGroups }) => {
    seen.navGroups = groups;
    return null;
  },
  ShellNavSearch: () => null,
}));
vi.mock('./shell-state', () => ({ CollapseToggle: () => null, DrawerCloseButton: () => null }));
// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({ getMe: vi.fn() }));

import type { Permission } from '@bos/contracts';

import { permissionsFrom } from '@/lib/live-permissions';

import { Sidebar } from './sidebar';

const USER_ID = '00000000-0000-4000-8000-000000000011';
const PICTURE = '00000000-0000-4000-8000-0000000000aa';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  seen.avatars = [];
  seen.uploads = [];
  seen.avatarMounts = 0;
  seen.navGroups = [];
  seen.refresh.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

describe('Sidebar account', () => {
  it("passes the person's id and picture to the avatar, keeping the name and detail", async () => {
    mounted = await mountForm(
      <Sidebar
        user={{ name: 'Finance, Sales', detail: 'staff', id: USER_ID, imageDocumentId: PICTURE }}
        permissions={['invoice.read']}
      />,
    );
    expect(seen.avatars.at(-1)).toMatchObject({
      name: 'Finance',
      seedId: USER_ID,
      imageDocumentId: PICTURE,
    });
    expect(mounted.container.textContent).toContain('Finance, Sales');
    expect(mounted.container.textContent).toContain('staff');
  });

  it('opens the profile picture dialog for their own picture from the account', async () => {
    mounted = await mountForm(
      <Sidebar
        user={{ name: 'Finance', detail: 'staff', id: USER_ID, imageDocumentId: PICTURE }}
        permissions={['invoice.read']}
      />,
    );
    const trigger = mounted.container.querySelector('button[aria-label="Profile picture"]');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await click(trigger);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Profile picture');
    expect(seen.uploads.at(-1)).toMatchObject({
      ownerType: 'user_avatar',
      ownerId: USER_ID,
      imageDocumentId: PICTURE,
      name: 'Finance',
      seedId: USER_ID,
      shape: 'circle',
      fit: 'cover',
      label: 'Your profile picture',
    });
    (seen.uploads.at(-1)?.onChange as (id: string | null) => void)(null);
    expect(seen.refresh).toHaveBeenCalledTimes(1);

    const close = Array.from(dialog?.querySelectorAll('footer button') ?? []).find(
      (b) => b.textContent === 'Close',
    );
    const mountsBeforeClose = seen.avatarMounts;
    await click(close ?? null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The sidebar picture gets a fresh try: a new upload 404s while it is scanning, and Avatar keeps a failure.
    expect(seen.avatarMounts).toBe(mountsBeforeClose + 1);
  });

  it('shows the picture without the upload when the id is unknown', async () => {
    mounted = await mountForm(
      <Sidebar
        user={{ name: 'Finance', detail: 'staff', imageDocumentId: PICTURE }}
        permissions={['invoice.read']}
      />,
    );
    expect(mounted.container.querySelector('button[aria-label="Profile picture"]')).toBeNull();
    expect(seen.avatars.at(-1)).toMatchObject({ name: 'Finance', imageDocumentId: PICTURE });
  });
});

describe('Sidebar navigation', () => {
  const navLabels = () => seen.navGroups.flatMap((group) => group.items.map((item) => item.label));
  const user = { name: 'Sales', detail: 'staff' };

  it('shows Settings to a non-Founder role granted a settings permission, and gated items it holds', async () => {
    mounted = await mountForm(
      <Sidebar user={user} permissions={['admin.users.read', 'invoice.read']} />,
    );
    expect(navLabels()).toEqual(expect.arrayContaining(['Settings', 'Invoices']));
  });

  it('hides Settings and the gated items without those grants', async () => {
    mounted = await mountForm(<Sidebar user={user} permissions={['customer.read']} />);
    expect(navLabels()).not.toContain('Settings');
    expect(navLabels()).not.toContain('Invoices');
    expect(navLabels()).toContain('Customers');
  });

  // The layout passes `permissionsFrom(/v1/me, roles)`: the saved grants, not the role defaults.
  const saved = (granted: Permission[] | null, roles: string[]) =>
    permissionsFrom(
      granted === null
        ? null
        : { permissions: granted.map((permission) => ({ permission, scope: 'all' as const })) },
      roles,
    );

  it('follows saved grants where they differ from the role defaults', async () => {
    // Sales holds neither by default; the saved role adds both.
    mounted = await mountForm(
      <Sidebar user={user} permissions={saved(['ar.read', 'procurement.sourcing'], ['sales'])} />,
    );
    expect(navLabels()).toEqual(expect.arrayContaining(['Receivables', 'Requests for quotation']));
    await mounted.unmount();
    // The Founder holds every default; a saved list without settings or sourcing grants hides them.
    mounted = await mountForm(
      <Sidebar user={user} permissions={saved(['customer.read'], ['founder'])} />,
    );
    expect(navLabels()).not.toContain('Settings');
    expect(navLabels()).not.toContain('Requests for quotation');
    expect(navLabels()).toContain('Customers');
  });

  it('uses the role defaults only when /v1/me fails', async () => {
    mounted = await mountForm(<Sidebar user={user} permissions={saved(null, ['founder'])} />);
    expect(navLabels()).toEqual(expect.arrayContaining(['Settings', 'Requests for quotation']));
  });
});
