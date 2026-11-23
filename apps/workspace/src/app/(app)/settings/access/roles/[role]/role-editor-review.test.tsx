// @vitest-environment jsdom
import type { AccessRoleInfo, RoleKey } from '@bos/contracts';
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { roleGroups } from '../_lib/role-model';
import { testCatalogue } from '../_lib/test-catalogue';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const actions = vi.hoisted(() => ({ previewAccessAction: vi.fn(), saveAccessAction: vi.fn() }));
vi.mock('../actions', () => actions);

// The review dialog belongs to its own unit; here it is a stub that shows what it was opened with.
interface DialogProps {
  open: boolean;
  title: string;
  changes: unknown[];
  onStale: () => void;
  onSaved: () => void;
}
const dialog = vi.hoisted(() => ({ last: null as DialogProps | null }));
vi.mock('@/components/access/review-changes-dialog', () => ({
  ReviewChangesDialog: (props: DialogProps) => {
    dialog.last = props;
    return props.open ? (
      <div
        data-testid="review"
        aria-label={props.title}
        data-changes={JSON.stringify(props.changes)}
      />
    ) : null;
  },
}));

const { RoleEditor } = await import('./role-editor');

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
  router.push.mockReset();
  router.refresh.mockReset();
  actions.previewAccessAction.mockReset();
  actions.saveAccessAction.mockReset();
  dialog.last = null;
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  document.body.innerHTML = '';
});

async function mountSales() {
  const role = roleOf('sales');
  view = await mountForm(
    <RoleEditor
      role={role}
      roles={catalogue.roles.map((r) => ({ key: r.key, label: r.label }))}
      groups={roleGroups(catalogue, role)}
      edited
      canWrite
      revision="rev-7"
    />,
  );
}

const buttonNamed = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ??
  null;
const controlFor = (label: string) => {
  const found = Array.from(document.querySelectorAll('label')).find(
    (l) => l.textContent?.trim() === label,
  );
  return found ? document.getElementById(found.htmlFor) : null;
};
const reviewed = () => {
  const node = document.querySelector('[data-testid="review"]');
  return node ? (JSON.parse(node.getAttribute('data-changes') ?? '[]') as unknown[]) : null;
};

describe('the By role review flow', () => {
  it('keeps Review changes disabled until a value changes, then reviews exactly that change', async () => {
    await mountSales();
    expect(buttonNamed('Review changes')?.hasAttribute('disabled')).toBe(true);

    await click(controlFor('Issue an invoice'));
    expect(buttonNamed('Review changes')?.hasAttribute('disabled')).toBe(false);

    await click(buttonNamed('Review changes'));
    expect(reviewed()).toEqual([
      { kind: 'grant', role: 'sales', permission: 'invoice.issue', scope: 'all' },
    ]);
    expect(document.querySelector('[data-testid="review"]')?.getAttribute('aria-label')).toBe(
      'Review changes to the Sales role',
    );
    // Opening the review writes nothing: only the dialog's own Save may.
    expect(actions.saveAccessAction).not.toHaveBeenCalled();
  });

  it('names the undo icon after what it resets and draws it only for changed values', async () => {
    await mountSales();
    const undo = document.querySelector(
      'button[aria-label="Reset See leads for Sales to the default: Their own"]',
    );
    expect(undo).not.toBeNull();
    expect(document.querySelector('button[aria-label^="Reset Create and edit leads"]')).toBeNull();

    await click(undo);
    expect(reviewed()).toEqual([
      { kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'own' },
    ]);
  });

  it('with unsaved edits, the undo icon only puts that one control back', async () => {
    await mountSales();
    await click(controlFor('Issue an invoice'));
    const undo = document.querySelector(
      'button[aria-label="Reset Issue an invoice for Sales to the default: Off"]',
    );
    await click(undo);
    expect(reviewed()).toBeNull();
    expect(controlFor('Issue an invoice')?.getAttribute('aria-checked')).toBe('false');
    expect(buttonNamed('Review changes')?.hasAttribute('disabled')).toBe(true);
  });

  it('reviews a reset of the whole role from Reset to defaults', async () => {
    await mountSales();
    await click(buttonNamed('Reset to defaults'));
    expect(reviewed()).toEqual([{ kind: 'resetRole', role: 'sales' }]);
  });

  it('keeps the choices and offers Reload when the save is refused as stale', async () => {
    await mountSales();
    await click(controlFor('Issue an invoice'));
    await click(buttonNamed('Review changes'));
    await act(() => {
      dialog.last?.onStale();
      return Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      'Access was changed by someone else. Reload to see the latest.',
    );
    expect(controlFor('Issue an invoice')?.getAttribute('aria-checked')).toBe('true');
    await click(buttonNamed('Reload'));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('clears the choices and refreshes after a save', async () => {
    await mountSales();
    await click(controlFor('Issue an invoice'));
    await click(buttonNamed('Review changes'));
    await act(() => {
      dialog.last?.onSaved();
      return Promise.resolve();
    });
    expect(reviewed()).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
    expect(buttonNamed('Review changes')?.hasAttribute('disabled')).toBe(true);
  });
});
