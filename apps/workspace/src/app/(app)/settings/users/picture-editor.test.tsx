// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ImageUploadProps } from '@/components/ui/image-upload';
import { click, mountForm } from '@/test/form-interactions';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

// The shared upload has its own tests; here only what the row hands it matters.
const upload = vi.hoisted(() => ({ props: null as ImageUploadProps | null }));
vi.mock('@/components/ui/image-upload', () => ({
  ImageUpload: (props: ImageUploadProps) => {
    upload.props = props;
    return <div role="group" aria-label={props.label} />;
  },
}));

import { PictureEditor } from './picture-editor';

const USER = '00000000-0000-4000-9000-00000000000a';
const PICTURE = '00000000-0000-4000-a000-0000000000ff';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  router.refresh.mockReset();
  upload.props = null;
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const trigger = () =>
  mounted!.container.querySelector<HTMLButtonElement>('button[aria-label="Change Asha picture"]');

it('opens a profile picture dialog for that user, refreshes the page on a change and only closes', async () => {
  mounted = await mountForm(
    <PictureEditor
      userId={USER}
      name="Asha"
      label="Asha · asha@example.test"
      imageDocumentId={PICTURE}
    />,
  );
  expect(trigger()?.getAttribute('aria-label')).toBe('Change Asha picture');
  // The hint is the design-system Tooltip, not the browser's native title bubble.
  expect(trigger()?.hasAttribute('title')).toBe(false);
  expect(upload.props).toBeNull();

  await click(trigger());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('Profile picture');
  expect(dialog?.textContent).toContain('Asha · asha@example.test');
  expect(dialog?.querySelector('[role="group"][aria-label="Profile picture"]')).toBeTruthy();
  expect(upload.props).toMatchObject({
    ownerType: 'user_avatar',
    ownerId: USER,
    imageDocumentId: PICTURE,
    name: 'Asha',
    seedId: USER,
    shape: 'circle',
    fit: 'cover',
  });

  act(() => upload.props!.onChange('00000000-0000-4000-a000-000000000100'));
  expect(router.refresh).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();

  const footer = Array.from(dialog!.querySelectorAll('footer button'));
  expect(footer.map((b) => b.textContent)).toEqual(['Close']);
  await click(footer[0]!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('hands a person with no picture to the upload as null', async () => {
  mounted = await mountForm(
    <PictureEditor userId={USER} name="Asha" label="Asha" imageDocumentId={null} />,
  );
  await click(trigger());
  expect(upload.props?.imageDocumentId).toBeNull();
});
