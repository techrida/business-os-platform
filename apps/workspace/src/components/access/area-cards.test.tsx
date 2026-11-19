// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

import { accessCatalogue } from '@/test/access-catalogue';
import { click, mountForm } from '@/test/form-interactions';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AreaCards, type AreaCardsActions } from './area-cards';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
let actions: {
  preview: Mock<AreaCardsActions['preview']>;
  save: Mock<AreaCardsActions['save']>;
  check: Mock<AreaCardsActions['check']>;
};

beforeEach(() => {
  router.push.mockReset();
  router.refresh.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  actions = {
    preview: vi.fn<AreaCardsActions['preview']>(() =>
      Promise.resolve({
        ok: true,
        preview: {
          applied: [],
          impact: {
            widened: { people: 0, sample: [] },
            narrowed: { people: 0, sample: [] },
            unchanged: 0,
          },
          warnings: [],
          summaries: {},
          assignmentSummaries: {},
        },
      }),
    ),
    save: vi.fn<AreaCardsActions['save']>(() => Promise.resolve({ ok: true })),
    check: vi.fn<AreaCardsActions['check']>(() =>
      Promise.resolve({ ok: false, message: 'Not used here.' }),
    ),
  };
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function render(canEdit = true) {
  mounted = await mountForm(
    <AreaCards
      catalogue={accessCatalogue()}
      canEdit={canEdit}
      departments={[]}
      people={[]}
      actions={actions}
    />,
  );
  return mounted.container;
}

function byLabel(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No button labelled "${label}"`);
  return found;
}

function textButton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

const cardTitles = (container: HTMLElement) =>
  [...container.querySelectorAll('section h2')].map((h) => h.textContent);

it('shows the nine areas in the catalogue order, each with its summary', async () => {
  const container = await render();
  expect(cardTitles(container)).toEqual([
    'Leads',
    'Opportunities',
    'Quotations',
    'Sales orders',
    'Invoices',
    'Procurement',
    'Payables',
    'Approvals',
    'Documents',
  ]);
  expect(container.textContent).toContain('Sales and Marketing see their own leads.');
  expect(container.textContent).toContain('Only Founders can see invoices.');
});

const card = (title: string): HTMLElement => {
  const headings = [...document.querySelectorAll('section h2')];
  const heading = headings.find((h) => h.textContent === title);
  const section = heading?.closest('section');
  if (!section) throw new Error(`No card ${title}`);
  return section;
};

it('opens Leads with a locked Founder row, staff roles, levels and the assign block', async () => {
  await render();
  await click(byLabel('Edit Leads'));
  const leads = card('Leads');

  const founder = [...leads.querySelectorAll('li')].find((li) =>
    li.textContent?.includes('Founders always have full access.'),
  );
  expect(founder?.querySelector('button')?.disabled).toBe(true);
  for (const role of ['Management', 'Sales', 'Marketing']) {
    expect(leads.querySelector(`[aria-label="${role} can see leads"]`)).not.toBeNull();
  }
  expect(leads.textContent).toContain('2 roles with no access');
  expect(leads.textContent).toContain('Managers also see their whole department');
  expect(leads.textContent).toContain('Department heads also see their whole department');
  expect(leads.textContent).toContain('Who can assign leads');
  expect(leads.textContent).toContain('Staff can assign to');
  expect(leads.textContent).toContain(
    'Founders can assign to anyone. Nobody can assign to someone above their own level.',
  );
  // Portal roles never appear in an area card (acceptance criterion 4.3).
  expect(leads.textContent).not.toContain('Customer portal user');
  expect(leads.textContent).not.toContain('Vendor portal user');
});

it('shows no Who can assign block on Invoices and only a fixed line on Quotations', async () => {
  await render();
  await click(byLabel('Edit Invoices'));
  expect(card('Invoices').textContent).not.toContain('Who can assign');

  await click(byLabel('Edit Quotations'));
  const quotations = card('Quotations');
  expect(quotations.textContent).toContain('Quotations follow their opportunity.');
  expect(quotations.textContent).not.toContain('Staff can assign to');
});

async function flush() {
  const { act } = await import('react');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const checkbox = (scope: HTMLElement, text: string): HTMLInputElement => {
  const label = [...scope.querySelectorAll('label')].find((l) => l.textContent?.includes(text));
  const input = label?.querySelector('input');
  if (!input) throw new Error(`No checkbox "${text}"`);
  return input;
};

it('sends nothing that writes until Save changes in the review dialog', async () => {
  await render();
  await click(byLabel('Edit Leads'));
  const leads = card('Leads');
  expect(textButton('Review changes').disabled).toBe(true);

  await click(checkbox(leads, 'Managers also see their whole department'));
  expect(textButton('Review changes').disabled).toBe(false);
  await click(textButton('Review changes'));
  await flush();
  expect(actions.preview).toHaveBeenCalledWith({
    changes: [{ kind: 'levelRule', area: 'leads', managersSeeDepartment: false }],
  });
  expect(actions.save).not.toHaveBeenCalled();

  await click(textButton('Save changes'));
  await flush();
  expect(actions.save).toHaveBeenCalledWith({
    changes: [{ kind: 'levelRule', area: 'leads', managersSeeDepartment: false }],
    expectedRevision: '7',
    acknowledged: [],
    note: '',
  });
  expect(router.refresh).toHaveBeenCalled();
});

it('names each undo icon after what it resets, shows none at the default and reviews it', async () => {
  await render();
  await click(byLabel('Edit Leads'));
  expect(card('Leads').querySelector('button[aria-label^="Reset "]')).toBeNull();

  await click(byLabel('Edit Opportunities'));
  const opportunities = card('Opportunities');
  const undo = byLabel('Reset Sales on Opportunities to the default: Their own');
  expect(opportunities.querySelector('button[aria-label^="Reset Management"]')).toBeNull();

  await click(undo);
  await flush();
  expect(actions.preview).toHaveBeenCalledWith({
    changes: [{ kind: 'grant', role: 'sales', permission: 'crm.opportunity.read', scope: 'own' }],
  });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Review changes to Opportunities',
  );
});

it('puts no permission key and no role key with an underscore on the page', async () => {
  await render();
  await click(byLabel('Edit Leads'));
  // Links carry role keys as route parameters; everything else a person can read or hear is checked.
  const html = document.body.innerHTML.replace(/href="[^"]*"/g, '');
  for (const permission of accessCatalogue().permissions.map((p) => p.key)) {
    expect(html).not.toContain(permission);
  }
  for (const role of ['operations_head', 'customer_user', 'vendor_user']) {
    expect(html).not.toContain(role);
  }
});

it('shows view-only cards with every control disabled and no foot buttons', async () => {
  await render(false);
  await click(byLabel('View Leads'));
  const leads = card('Leads');
  const controls = [
    ...leads.querySelectorAll<HTMLButtonElement | HTMLInputElement>('li button, input'),
  ];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) expect(control.disabled).toBe(true);
  expect(leads.textContent).not.toContain('Review changes');
  expect(leads.textContent).not.toContain('Discard');
  expect(leads.querySelector('button[aria-label^="Reset "]')).toBeNull();
});
