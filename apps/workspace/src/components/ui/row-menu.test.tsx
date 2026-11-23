// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { Dialog } from './dialog';
import { RowMenu } from './row-menu';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // The popover measures its trigger; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  document.body.innerHTML = '';
});

it('is one button named for its row, closed until it is used', async () => {
  const view = await mountForm(
    <RowMenu
      label="Actions for Himal Traders"
      items={[{ label: 'Edit', href: '/customers/1/edit' }]}
    />,
  );
  const button = document.querySelector<HTMLButtonElement>('button');
  expect(button?.getAttribute('aria-label')).toBe('Actions for Himal Traders');
  expect(button?.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('a')).toBeNull();
  await view.unmount();
});

it('lists its links once opened', async () => {
  const view = await mountForm(
    <RowMenu
      label="Actions for Himal Traders"
      items={[{ label: 'Edit', href: '/customers/1/edit' }]}
    />,
  );
  await click(document.querySelector('button'));
  const link = document.querySelector<HTMLAnchorElement>('a');
  expect(link?.textContent).toBe('Edit');
  expect(link?.getAttribute('href')).toBe('/customers/1/edit');
  await view.unmount();
});

it('renders nothing when the viewer may take no action', async () => {
  const view = await mountForm(<RowMenu label="Actions" items={[]} />);
  expect(document.querySelector('button')).toBeNull();
  await view.unmount();
});

it('walks items with ArrowDown, ArrowUp, Home and End, and closes on Escape', async () => {
  const view = await mountForm(
    <RowMenu
      label="Actions for Himal Traders"
      items={[
        { label: 'View', href: '/customers/1' },
        { label: 'Edit', href: '/customers/1/edit' },
        { label: 'Invoices', href: '/invoices?customer=1' },
      ]}
    />,
  );
  const trigger = document.querySelector<HTMLButtonElement>('button')!;
  trigger.focus();
  await click(trigger);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'));
  expect(links).toHaveLength(3);

  const press = (key: string) =>
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      return new Promise((resolve) => setTimeout(resolve, 0));
    });

  links[0]!.focus();
  await press('ArrowDown');
  expect(document.activeElement).toBe(links[1]);
  await press('End');
  expect(document.activeElement).toBe(links[2]);
  await press('ArrowDown');
  expect(document.activeElement).toBe(links[0]);
  await press('ArrowUp');
  expect(document.activeElement).toBe(links[2]);
  await press('Home');
  expect(document.activeElement).toBe(links[0]);
  await press('Escape');
  // Radix hands focus back to the trigger after the close, not in the same tick; a slow runner saw <body> (GitHub run 45148774320).
  await vi.waitFor(() => {
    expect(document.querySelector('a')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  await view.unmount();
});

it('runs button action items and closes the menu', async () => {
  const onRename = vi.fn();
  const view = await mountForm(
    <RowMenu label="Department actions" items={[{ label: 'Rename', onSelect: onRename }]} />,
  );
  await click(document.querySelector('button[aria-label="Department actions"]'));
  const action = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'Rename',
  )!;
  await click(action);
  expect(onRename).toHaveBeenCalledTimes(1);
  expect(document.querySelector('ul')).toBeNull();
  await view.unmount();
});

it('portals inside an enclosing Dialog via PopoverContainerContext', async () => {
  const view = await mountForm(
    <Dialog open title="Records">
      <RowMenu label="Row actions" items={[{ label: 'Open', href: '/records/1' }]} />
    </Dialog>,
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  await click(dialog.querySelector('button[aria-label="Row actions"]'));
  const link = document.querySelector('a[href="/records/1"]')!;
  expect(dialog.contains(link)).toBe(true);
  await view.unmount();
});
