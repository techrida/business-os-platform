// @vitest-environment jsdom
import { AVATAR_PALETTE, avatarColour } from '@bos/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { announceImageReady, Avatar } from './avatar';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  document.body.innerHTML = '';
});

const avatar = (container: HTMLElement) => container.querySelector<HTMLSpanElement>('span')!;
const fill = (container: HTMLElement) => avatar(container).style.getPropertyValue('--avatar-fill');

const IMAGE_ID = '0b9a4f8e-6a5d-4c1e-9f3b-2d7c8e1a5b40';
const OTHER_IMAGE_ID = '7c2e9d14-3b8a-4f6e-a1d5-9e0b4c7f2a68';

it('shows up to two initials, or "?" when the name has no letters, and stays hidden from assistive tech', async () => {
  const view = await mountForm(<Avatar name="Ada  Lovelace-King" />);
  expect(avatar(view.container).textContent).toBe('AL');
  expect(avatar(view.container).getAttribute('aria-hidden')).toBe('true');
  expect(view.container.querySelector('img')).toBeNull();
  await view.unmount();

  const empty = await mountForm(<Avatar name="  " />);
  expect(avatar(empty.container).textContent).toBe('?');
  await empty.unmount();
});

it('gives the same record the same background on every render', async () => {
  const id = 'f3c1a9e2-5b7d-4e8f-a0c6-1d2b3e4f5a6b';
  const first = await mountForm(<Avatar name="Ravi Shah" seedId={id} />);
  const firstFill = fill(first.container);
  await first.unmount();
  const second = await mountForm(<Avatar name="Someone Renamed" seedId={id} size="large" shape="circle" />);
  expect(fill(second.container)).toBe(firstFill);
  expect(firstFill).toBe(avatarColour(id));
  await second.unmount();
});

it('spreads different records across the palette', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const fills = new Set<string>();
  for (const id of ids) {
    const view = await mountForm(<Avatar name="Customer" seedId={id} />);
    fills.add(fill(view.container));
    await view.unmount();
  }
  expect(fills.size).toBeGreaterThan(1);
  for (const colour of fills) expect(AVATAR_PALETTE).toContain(colour);
});

it('uses the neutral colour when there is no record id yet', async () => {
  const view = await mountForm(<Avatar name="New Customer" />);
  expect(fill(view.container)).toBe(AVATAR_PALETTE[AVATAR_PALETTE.length - 1]);
  await view.unmount();
});

it('renders the picture from the image route above the initials', async () => {
  const view = await mountForm(<Avatar name="Ada Lovelace" seedId="u-1" imageDocumentId={IMAGE_ID} />);
  const image = view.container.querySelector('img');
  expect(image?.getAttribute('src')).toBe(`/api/images/${IMAGE_ID}`);
  expect(image?.getAttribute('alt')).toBe('');
  expect(image?.getAttribute('loading')).toBe('lazy');
  expect(image?.getAttribute('decoding')).toBe('async');
  expect(avatar(view.container).textContent).toBe('AL');
  await view.unmount();
});

it('falls back to the initials when the picture fails, and tries again for a new picture', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (documentId: string) =>
    act(() =>
      Promise.resolve(root.render(<Avatar name="Ada Lovelace" imageDocumentId={documentId} fit="contain" />)),
    );

  await render(IMAGE_ID);
  const image = container.querySelector('img')!;
  await act(() => Promise.resolve(image.dispatchEvent(new Event('error'))));
  expect(container.querySelector('img')).toBeNull();
  expect(avatar(container).textContent).toBe('AL');

  // The same avatar, now pointing at a newly uploaded picture.
  await render(OTHER_IMAGE_ID);
  expect(container.querySelector('img')?.getAttribute('src')).toBe(`/api/images/${OTHER_IMAGE_ID}`);
  await act(() => Promise.resolve(root.unmount()));
});

it('keeps the initials when re-rendered with the same failed picture, and tries again once it is announced ready', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    act(() => Promise.resolve(root.render(<Avatar name="Ada Lovelace" imageDocumentId={IMAGE_ID} />)));

  await render();
  const image = container.querySelector('img')!;
  // A 404 while the new picture is still being scanned.
  await act(() => Promise.resolve(image.dispatchEvent(new Event('error'))));
  expect(container.querySelector('img')).toBeNull();

  // A page refresh hands the avatar the same picture: it stays on the initials.
  await render();
  expect(container.querySelector('img')).toBeNull();

  // Another picture becoming ready changes nothing here.
  await act(() => Promise.resolve(announceImageReady(OTHER_IMAGE_ID)));
  expect(container.querySelector('img')).toBeNull();

  // This picture passed its scan: a fresh image asks for it again.
  await act(() => Promise.resolve(announceImageReady(IMAGE_ID)));
  const retried = container.querySelector('img');
  expect(retried?.getAttribute('src')).toBe(`/api/images/${IMAGE_ID}`);
  expect(retried).not.toBe(image);
  await act(() => Promise.resolve(root.unmount()));
});
