// @vitest-environment jsdom
import { AVATAR_PALETTE, avatarColour } from '@bos/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { announceImageReady, Avatar } from './avatar';
import { scanPollDelays } from './scan-poll';

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
  const second = await mountForm(
    <Avatar name="Someone Renamed" seedId={id} size="large" shape="circle" />,
  );
  expect(fill(second.container)).toBe(firstFill);
  expect(firstFill).toBe(avatarColour(id));
  await second.unmount();
});

it('spreads different records across the palette', async () => {
  const ids = Array.from(
    { length: 12 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
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
  const view = await mountForm(
    <Avatar name="Ada Lovelace" seedId="u-1" imageDocumentId={IMAGE_ID} />,
  );
  const image = view.container.querySelector('img');
  expect(image?.getAttribute('src')).toBe(`/api/images/${IMAGE_ID}`);
  expect(image?.getAttribute('alt')).toBe('');
  expect(image?.getAttribute('loading')).toBe('lazy');
  expect(image?.getAttribute('decoding')).toBe('async');
  expect(avatar(view.container).textContent).toBe('AL');
  await view.unmount();
});

/** A root the test re-renders by hand, for the picture's failure and retry states. */
function mountRoot() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: (documentId: string | null = IMAGE_ID) =>
      act(() =>
        Promise.resolve(root.render(<Avatar name="Ada Lovelace" imageDocumentId={documentId} />)),
      ),
    image: () => container.querySelector('img'),
    // The picture answers 404 (still being scanned) or loads.
    fail: () =>
      act(() => Promise.resolve(container.querySelector('img')!.dispatchEvent(new Event('error')))),
    wait: (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      }),
    unmount: () => act(() => Promise.resolve(root.unmount())),
  };
}

describe('a picture that fails', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the initials and asks again on the scan backoff, drawing the picture once a try succeeds', async () => {
    const view = mountRoot();
    await view.render();
    const first = view.image()!;
    await view.fail();
    expect(view.image()).toBeNull();
    expect(avatar(view.container).textContent).toBe('AL');

    // A re-render mid-wait (a router refresh) does not restart the wait.
    await view.wait(500);
    await view.render();
    await view.wait(499);
    expect(view.image()).toBeNull();
    await view.wait(1);
    const second = view.image();
    expect(second?.getAttribute('src')).toBe(`/api/images/${IMAGE_ID}`);
    expect(second).not.toBe(first);

    // Still scanning: the next try waits twice as long.
    await view.fail();
    await view.wait(1_999);
    expect(view.image()).toBeNull();
    await view.wait(1);
    const third = view.image();
    expect(third).not.toBeNull();
    expect(third).not.toBe(second);

    // This try loads: the picture stays and nothing else is scheduled.
    expect(vi.getTimerCount()).toBe(0);
    await view.wait(120_000);
    expect(view.image()).toBe(third);
    await view.unmount();
  });

  it('keeps a retry transparent until its picture arrives, so the initials never blink', async () => {
    const view = mountRoot();
    await view.render();
    // The first try draws as it always has.
    expect(view.image()?.style.opacity).toBe('');
    await view.fail();
    await view.wait(1_000);
    expect(view.image()?.style.opacity).toBe('0');
    await act(() => Promise.resolve(view.image()!.dispatchEvent(new Event('load'))));
    expect(view.image()?.style.opacity).toBe('');
    await view.unmount();

    // A retry started by an announcement is hidden the same way.
    const announced = mountRoot();
    await announced.render();
    await announced.fail();
    await act(() => Promise.resolve(announceImageReady(IMAGE_ID)));
    expect(announced.image()?.style.opacity).toBe('0');
    await act(() => Promise.resolve(announced.image()!.dispatchEvent(new Event('load'))));
    expect(announced.image()?.style.opacity).toBe('');
    await announced.unmount();
  });

  it('gives up after the first request and seven retries, keeping the initials', async () => {
    const view = mountRoot();
    await view.render();
    await view.fail();
    for (const delay of scanPollDelays()) {
      await view.wait(delay - 1);
      expect(view.image()).toBeNull();
      await view.wait(1);
      expect(view.image()?.getAttribute('src')).toBe(`/api/images/${IMAGE_ID}`);
      await view.fail();
    }
    expect(scanPollDelays()).toHaveLength(7);
    expect(vi.getTimerCount()).toBe(0);
    await view.wait(120_000);
    expect(view.image()).toBeNull();
    expect(avatar(view.container).textContent).toBe('AL');

    // A page refresh with the same picture does not start over.
    await view.render();
    expect(view.image()).toBeNull();
    await view.unmount();
  });

  it('tries at once when the picture is announced ready, and the waits start over', async () => {
    const view = mountRoot();
    await view.render();
    const first = view.image()!;
    await view.fail();

    // Another picture becoming ready changes nothing here.
    await act(() => Promise.resolve(announceImageReady(OTHER_IMAGE_ID)));
    expect(view.image()).toBeNull();

    // This picture passed its scan: a fresh image asks for it again now, and the pending wait is dropped.
    await act(() => Promise.resolve(announceImageReady(IMAGE_ID)));
    const retried = view.image();
    expect(retried?.getAttribute('src')).toBe(`/api/images/${IMAGE_ID}`);
    expect(retried).not.toBe(first);
    expect(vi.getTimerCount()).toBe(0);
    await view.unmount();
  });

  it('answers an announcement after giving up, with the next failure waiting the first delay again', async () => {
    const view = mountRoot();
    await view.render();
    await view.fail();
    for (const delay of scanPollDelays()) {
      await view.wait(delay);
      await view.fail();
    }
    expect(view.image()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    await act(() => Promise.resolve(announceImageReady(IMAGE_ID)));
    expect(view.image()?.getAttribute('src')).toBe(`/api/images/${IMAGE_ID}`);
    await view.fail();
    await view.wait(999);
    expect(view.image()).toBeNull();
    await view.wait(1);
    expect(view.image()).not.toBeNull();
    await view.unmount();
  });

  it('starts a new picture from a first try, with no wait left from the old one', async () => {
    const view = mountRoot();
    await view.render();
    await view.fail();
    await view.wait(1_000);
    await view.fail();
    // Two seconds are now pending for the old picture; a newly uploaded one replaces it mid-wait.
    await view.render(OTHER_IMAGE_ID);
    expect(view.image()?.getAttribute('src')).toBe(`/api/images/${OTHER_IMAGE_ID}`);
    expect(vi.getTimerCount()).toBe(0);

    // Its first failure waits one second, not the old picture's next delay.
    await view.fail();
    await view.wait(999);
    expect(view.image()).toBeNull();
    await view.wait(1);
    expect(view.image()?.getAttribute('src')).toBe(`/api/images/${OTHER_IMAGE_ID}`);

    // Removing the picture drops any wait too.
    await view.fail();
    await view.render(null);
    expect(vi.getTimerCount()).toBe(0);
    expect(avatar(view.container).textContent).toBe('AL');
    await view.unmount();
  });

  it('leaves no timer behind when it unmounts mid-wait', async () => {
    const view = mountRoot();
    await view.render();
    await view.fail();
    expect(vi.getTimerCount()).toBe(1);
    await view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts two reports of the same failed try as one failure', async () => {
    const view = mountRoot();
    await view.render();
    const image = view.image()!;
    await act(() => {
      image.dispatchEvent(new Event('error'));
      image.dispatchEvent(new Event('error'));
      return Promise.resolve();
    });
    // One failure spends the first wait only, not the first two.
    await view.wait(1_000);
    expect(view.image()?.getAttribute('src')).toBe(`/api/images/${IMAGE_ID}`);
    await view.unmount();
  });
});
