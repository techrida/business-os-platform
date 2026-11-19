// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const seen = vi.hoisted(() => ({
  avatars: [] as Array<Record<string, unknown>>,
  uploads: [] as Array<Record<string, unknown>>,
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: seen.refresh }) }));
vi.mock('@/components/ui/avatar', () => ({
  Avatar: (props: Record<string, unknown>) => {
    seen.avatars.push(props);
    return <span data-testid="avatar" />;
  },
}));
vi.mock('@/components/ui/image-upload', () => ({
  ImageUpload: (props: Record<string, unknown>) => {
    seen.uploads.push(props);
    return <div data-testid="image-upload" />;
  },
}));
// The navigation and shell controls have their own tests; here they only need to stay out of the way.
vi.mock('./brand', () => ({ Brand: () => null }));
vi.mock('./shell-nav', () => ({ ShellNav: () => null, ShellNavSearch: () => null }));
vi.mock('./shell-state', () => ({ CollapseToggle: () => null, DrawerCloseButton: () => null }));

import { Sidebar } from './sidebar';

const USER_ID = '00000000-0000-4000-8000-000000000011';
const PICTURE = '00000000-0000-4000-8000-0000000000aa';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  seen.avatars = [];
  seen.uploads = [];
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
        roles={['finance']}
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
        roles={['finance']}
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
    await click(close ?? null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the picture without the upload when the id is unknown', async () => {
    mounted = await mountForm(
      <Sidebar
        user={{ name: 'Finance', detail: 'staff', imageDocumentId: PICTURE }}
        roles={['finance']}
      />,
    );
    expect(mounted.container.querySelector('button[aria-label="Profile picture"]')).toBeNull();
    expect(seen.avatars.at(-1)).toMatchObject({ name: 'Finance', imageDocumentId: PICTURE });
  });
});
