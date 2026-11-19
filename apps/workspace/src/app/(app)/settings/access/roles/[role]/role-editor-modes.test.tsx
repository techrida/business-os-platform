// @vitest-environment jsdom
import type { AccessRoleInfo, RoleKey } from '@bos/contracts';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { roleGroups } from '../_lib/role-model';
import { testCatalogue } from '../_lib/test-catalogue';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../actions', () => ({ previewAccessAction: vi.fn(), saveAccessAction: vi.fn() }));
vi.mock('@/components/access/review-changes-dialog', () => ({
  ReviewChangesDialog: () => null,
}));

const { RoleEditor, FOUNDER_LOCKED_MESSAGE, VIEW_ONLY_MESSAGE } = await import('./role-editor');

const catalogue = testCatalogue();
const roleOf = (key: RoleKey) => catalogue.roles.find((r) => r.key === key) as AccessRoleInfo;

let view: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  document.body.innerHTML = '';
});

async function mount(key: RoleKey, canWrite: boolean) {
  const role = roleOf(key);
  view = await mountForm(
    <RoleEditor
      role={role}
      roles={catalogue.roles.map((r) => ({ key: r.key, label: r.label }))}
      groups={roleGroups(catalogue, role)}
      edited={false}
      canWrite={canWrite}
      revision="rev-7"
    />,
  );
}

/** Every control inside a permission row (the role picker and the filters are outside them). */
const rowControls = () =>
  Array.from(document.querySelectorAll<HTMLElement>('ul li input, ul li button'));
const hasButton = (text: string) =>
  Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === text);

describe('By role modes', () => {
  it('locks every control on the Founder page and explains why', async () => {
    await mount('founder', true);
    expect(document.body.textContent).toContain(FOUNDER_LOCKED_MESSAGE);
    expect(rowControls().length).toBeGreaterThan(0);
    for (const control of rowControls()) expect(control.hasAttribute('disabled')).toBe(true);
    expect(hasButton('Reset to defaults')).toBe(false);
    expect(hasButton('Review changes')).toBe(false);
  });

  it('shows a view-only person every value with controls disabled and no foot', async () => {
    await mount('sales', false);
    expect(document.body.textContent).toContain(VIEW_ONLY_MESSAGE);
    for (const control of rowControls()) expect(control.hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('button[aria-label^="Reset "]')).toBeNull();
    expect(hasButton('Review changes')).toBe(false);
    expect(hasButton('Discard')).toBe(false);
  });

  it('gives a portal role only its portal rows, with the fixed company text', async () => {
    await mount('customer_user', true);
    const text = document.body.textContent ?? '';
    expect(text).toContain('View company quotations in portal');
    expect(text).toContain("Their own company's records");
    expect(text).not.toContain('See leads');
    expect(text).not.toContain('Their department');
    expect(text).not.toContain('Everything');
    expect(text).not.toMatch(/Their own(?! company)/);
  });

  it('shows no permission key or underscore role key anywhere a person can read or hear', async () => {
    for (const key of ['sales', 'operations_head', 'customer_user'] as const) {
      await mount(key, true);
      const heard = [
        document.body.textContent ?? '',
        ...Array.from(document.querySelectorAll('[aria-label], [title]')).flatMap((el) => [
          el.getAttribute('aria-label') ?? '',
          el.getAttribute('title') ?? '',
        ]),
      ].join('\n');
      expect(heard).not.toMatch(/\b[a-z]+(\.[a-z_]+)+\b/);
      expect(heard).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      await view?.unmount();
      view = undefined;
      document.body.innerHTML = '';
    }
  });
});
