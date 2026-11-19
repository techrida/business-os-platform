// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

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
