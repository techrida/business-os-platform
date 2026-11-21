import { DEFAULT_ROLE_PERMISSIONS, type Permission } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  NAV_GROUPS,
  SHIPPED_PHASES,
  isBuilt,
  ownsPath,
  searchNavGroups,
  visibleGroups,
} from './nav';

const items = NAV_GROUPS.flatMap((group) => group.items);

describe('NAV_GROUPS', () => {
  it('lists the sidebar groups in order without the removed Organization group', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      'Overview',
      'Work',
      'CRM',
      'Sales Management',
      'Sales',
      'Payments',
      'Purchases',
      'Payables',
      'System',
    ]);
  });

  it('has no empty group', () => {
    for (const group of NAV_GROUPS) expect(group.items.length).toBeGreaterThan(0);
  });

  it('has no duplicate labels', () => {
    const labels = items.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('has no duplicate hrefs', () => {
    const hrefs = items.flatMap((i) => (i.href === undefined ? [] : [i.href]));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives an absolute href to every built item', () => {
    for (const item of items) {
      if (isBuilt(item)) {
        expect(item.href, item.label).toMatch(/^\//);
      } else {
        expect(item.href, item.label).toBeUndefined();
      }
    }
  });

  it('ships P4 only with every P4 navigation destination linked and keeps later work unbuilt', () => {
    expect(SHIPPED_PHASES).toContain('P4');
    const p4Items = items.filter((item) => item.phase === 'P4');
    expect(p4Items).toHaveLength(9);
    for (const item of p4Items) {
      expect(item.href, item.label).toMatch(/^\//);
      expect(isBuilt(item), item.label).toBe(true);
    }
    for (const item of items.filter((i) => i.phase === 'later')) {
      expect(isBuilt(item), item.label).toBe(false);
    }
  });

  it('only builds items with a destination in a shipped phase', () => {
    for (const item of items.filter(isBuilt)) {
      expect(SHIPPED_PHASES, item.label).toContain(item.phase);
    }
    expect(isBuilt({ label: 'Future screen', href: '/future', icon: 'home', phase: 'later' })).toBe(
      false,
    );
    for (const phase of ['P3', 'P4'] as const) {
      expect(isBuilt({ label: 'Shipped screen', href: '/shipped', icon: 'home', phase })).toBe(
        true,
      );
    }
    expect(isBuilt({ label: 'No destination', icon: 'home', phase: 'P4' })).toBe(false);
  });

  it('links exactly the built pages', () => {
    const built = items.filter(isBuilt);
    expect(built.map((i) => [i.label, i.href])).toEqual([
      ['Overview', '/'],
      ['Inbox', '/inbox'],
      ['Memos', '/memos'],
      ['Customers', '/customers'],
      ['Leads', '/leads'],
      ['Opportunities', '/opportunities'],
      ['Lost deals', '/reports/lost-deals'],
      ['Quotations', '/quotations'],
      ['Verification', '/verification'],
      ['Activities & Tasks', '/activities'],
      ['Sales Orders', '/sales-orders'],
      ['Invoices', '/invoices'],
      ['Sales VAT register', '/invoices/vat-register'],
      ['Payments', '/payments'],
      ['Receivables', '/receivables/aging'],
      ['Purchase requests', '/procurement/requests'],
      ['Requests for quotation', '/procurement/rfqs'],
      ['Purchase orders', '/procurement/orders'],
      ['Receipts', '/procurement/receipts'],
      ['Vendors', '/vendors'],
      ['Bill inbox', '/payables/inbox'],
      ['Bills', '/payables/bills'],
      ['Payment requests', '/payables/payment-requests'],
      ['Purchase VAT register', '/payables/vat-register'],
      ['Settings', '/settings'],
    ]);
  });

  it('gates every P3 billing page by its read permission', () => {
    const permissionByLabel = Object.fromEntries(
      items.filter((i) => i.phase === 'P3' && isBuilt(i)).map((i) => [i.label, i.permission]),
    );
    expect(permissionByLabel).toEqual({
      'Sales Orders': 'sales_order.read',
      Invoices: 'invoice.read',
      'Sales VAT register': 'vat.sales.read',
      Payments: 'payment.read',
      Receivables: 'ar.read',
    });
  });

  it('parks Payment Methods at "later" because it has no screen', () => {
    const methods = items.find((i) => i.label === 'Payment Methods');
    expect(methods?.phase).toBe('later');
    expect(methods?.href).toBeUndefined();
    expect(items.some((i) => i.label === 'Payment to Confirm')).toBe(false);
  });

  it('gates every P2 CRM page by its read permission', () => {
    const permissionByLabel = Object.fromEntries(
      items.filter((i) => i.phase === 'P2' && isBuilt(i)).map((i) => [i.label, i.permission]),
    );
    expect(permissionByLabel).toEqual({
      Customers: 'customer.read',
      Leads: 'crm.lead.read',
      Opportunities: 'crm.opportunity.read',
      'Lost deals': 'crm.opportunity.read',
      Quotations: 'quotation.read',
      Verification: 'verification.read',
      'Activities & Tasks': 'crm.lead.read',
    });
  });

  it('keeps Customers and Verification in the CRM group, in the Figma order', () => {
    const crm = NAV_GROUPS.find((g) => g.label === 'CRM');
    const labels = crm?.items.map((i) => i.label) ?? [];
    expect(labels.indexOf('Customers')).toBeLessThan(labels.indexOf('Leads'));
    expect(labels.indexOf('Leads')).toBeLessThan(labels.indexOf('Opportunities'));
    expect(labels.indexOf('Opportunities')).toBeLessThan(labels.indexOf('Quotations'));
    expect(labels.indexOf('Quotations')).toBeLessThan(labels.indexOf('Verification'));
    expect(labels).not.toContain('Organizations');
  });

  it('lists the procurement pages after Payments with their permissions', () => {
    const labels = NAV_GROUPS.map((g) => g.label);
    expect(labels.indexOf('Purchases')).toBe(labels.indexOf('Payments') + 1);
    expect(NAV_GROUPS.find((g) => g.label === 'Purchases')?.items).toEqual([
      expect.objectContaining({
        label: 'Purchase requests',
        href: '/procurement/requests',
        phase: 'P4',
        permission: 'procurement.pr.read',
      }),
      expect.objectContaining({
        label: 'Requests for quotation',
        href: '/procurement/rfqs',
        phase: 'P4',
        permission: 'procurement.sourcing',
      }),
      expect.objectContaining({
        label: 'Purchase orders',
        href: '/procurement/orders',
        phase: 'P4',
        permission: [
          'procurement.po.issue',
          'payables.bill.enter',
          'payables.bill.read',
          'procurement.receipt.confirm',
        ],
      }),
      expect.objectContaining({
        label: 'Receipts',
        href: '/procurement/receipts',
        phase: 'P4',
        permission: [
          'procurement.receipt.confirm',
          'procurement.po.issue',
          'procurement.pr.create',
        ],
      }),
      expect.objectContaining({
        label: 'Vendors',
        href: '/vendors',
        phase: 'P4',
        permission: 'vendor.read',
      }),
    ]);
  });

  it('shows procurement links for any of their permissions and denies missing grants', () => {
    const purchases = NAV_GROUPS.find((g) => g.label === 'Purchases')?.items ?? [];
    for (const item of purchases) {
      const permissions =
        typeof item.permission === 'string' ? [item.permission] : (item.permission ?? []);
      for (const grant of permissions) {
        const shown = visibleGroups(false, (permission) => permission === grant).find(
          (g) => g.label === 'Purchases',
        )?.items;
        expect(shown).toContainEqual(item);
        for (const other of shown ?? []) {
          const allowed =
            typeof other.permission === 'string' ? [other.permission] : (other.permission ?? []);
          expect(allowed).toContain(grant);
        }
      }
    }
    expect(visibleGroups(false).some((g) => g.label === 'Purchases')).toBe(false);
    expect(visibleGroups(false, () => false).some((g) => g.label === 'Purchases')).toBe(false);
  });

  it.each(['warehouse', 'procurement', 'operations_officer', 'accountant'] as const)(
    'renders Receipts according to the real %s role grants',
    (role) => {
      const grants = DEFAULT_ROLE_PERMISSIONS[role];
      const labels = visibleGroups(
        false,
        (permission) => grants[permission as Permission] !== undefined,
      ).flatMap((group) => group.items.map((item) => item.label));
      expect(labels.includes('Receipts')).toBe(role !== 'accountant');
      if (role === 'accountant') {
        expect(
          visibleGroups(
            false,
            (permission) =>
              permission === 'procurement.pr.create' ||
              grants[permission as Permission] !== undefined,
          ).flatMap((group) => group.items.map((item) => item.label)),
        ).toContain('Receipts');
      }
    },
  );

  it('marks every /settings page as admin-only, and nothing else', () => {
    for (const item of items) {
      const isAdminPage = item.href?.startsWith('/settings') ?? false;
      expect(item.audience === 'admin', item.label).toBe(isAdminPage);
    }
  });

  it('moved Organization (Department, Users, Roles & Permissions, Approval Workflows) under Settings', () => {
    const labels = items.map((i) => i.label);
    for (const moved of ['Department', 'Users', 'Roles & Permissions', 'Approval Workflows']) {
      expect(labels).not.toContain(moved);
    }
    expect(items.some((i) => i.href?.startsWith('/admin'))).toBe(false);
    expect(NAV_GROUPS.some((g) => g.label === 'Organization')).toBe(false);
  });

  it('does not list Approvals or User twice (Inbox and Users replace them)', () => {
    const labels = items.map((i) => i.label);
    expect(labels).not.toContain('Approvals');
    expect(labels).not.toContain('User');
  });

  it('leaves Estimates out (decision D3 merged it into Quotations)', () => {
    expect(items.some((i) => /estimate/i.test(i.label))).toBe(false);
    expect(items.some((i) => i.label === 'Quotations')).toBe(true);
  });

  it('sets no counts in P0 (there is nothing to count yet)', () => {
    for (const item of items) expect(item.count, item.label).toBeUndefined();
  });

  it('links each Payables screen with its own permission and owns its nested paths', () => {
    expect(NAV_GROUPS.find((group) => group.label === 'Payables')?.items).toEqual([
      expect.objectContaining({
        label: 'Bill inbox',
        href: '/payables/inbox',
        permission: 'payables.bill.enter',
      }),
      expect.objectContaining({
        label: 'Bills',
        href: '/payables/bills',
        permission: 'payables.bill.read',
      }),
      expect.objectContaining({
        label: 'Payment requests',
        href: '/payables/payment-requests',
        permission: 'payables.payment.request',
      }),
      expect.objectContaining({
        label: 'Purchase VAT register',
        href: '/payables/vat-register',
        permission: 'payables.vat_register.read',
      }),
    ]);
    const denied = visibleGroups(false, () => false);
    expect(denied.find((group) => group.label === 'Payables')).toBeUndefined();
    const requestOnly = visibleGroups(
      false,
      (permission) => permission === 'payables.payment.request',
    );
    expect(
      requestOnly.find((group) => group.label === 'Payables')?.items.map((item) => item.label),
    ).toEqual(['Payment requests']);
  });

  it('shows each Payables link for its own grant and denies absent grants', () => {
    const payables = NAV_GROUPS.find((group) => group.label === 'Payables')?.items ?? [];
    for (const item of payables) {
      expect(
        visibleGroups(false, (permission) => permission === item.permission).find(
          (group) => group.label === 'Payables',
        )?.items,
      ).toEqual([item]);
    }
    expect(visibleGroups(false).some((group) => group.label === 'Payables')).toBe(false);
  });

  it('uses only known phases', () => {
    const phases = new Set(['P0', 'P1', 'P2', 'P3', 'P4', 'later']);
    for (const item of items) expect(phases.has(item.phase), item.label).toBe(true);
  });
});

describe('visibleGroups', () => {
  const labelsFor = (showAdmin: boolean) =>
    visibleGroups(showAdmin).flatMap((g) => g.items.map((i) => i.label));

  it('hides Settings from non-admins and has no Organization group', () => {
    expect(visibleGroups(false).map((g) => g.label)).not.toContain('Organization');
    expect(labelsFor(false)).not.toContain('Settings');
    expect(labelsFor(false)).toContain('Inbox');
    expect(labelsFor(false)).not.toContain('Help');
    expect(labelsFor(true)).not.toContain('Department');
  });

  it('shows Settings to admins without any Organization group', () => {
    expect(visibleGroups(true).map((g) => g.label)).not.toContain('Organization');
    expect(labelsFor(true)).toContain('Settings');
    expect(visibleGroups(true).find((g) => g.label === 'System')?.items).toEqual([
      expect.objectContaining({ label: 'Settings', href: '/settings' }),
    ]);
  });
});

describe('visibleGroups with permissions', () => {
  const labelsWith = (can?: (permission: string) => boolean) =>
    (can === undefined ? visibleGroups(false) : visibleGroups(false, can)).flatMap((g) =>
      g.items.map((i) => i.label),
    );

  it('hides every permission-gated item when no predicate is given (deny by default)', () => {
    const labels = labelsWith();
    for (const hidden of [
      'Customers',
      'Leads',
      'Opportunities',
      'Lost deals',
      'Quotations',
      'Verification',
      'Activities & Tasks',
      'Sales Orders',
      'Invoices',
      'Payments',
      'Receivables',
    ]) {
      expect(labels).not.toContain(hidden);
    }
    expect(labels).toContain('Inbox');
  });

  it('hides them when the predicate refuses', () => {
    const labels = labelsWith(() => false);
    expect(labels).not.toContain('Customers');
    expect(labels).not.toContain('Verification');
  });

  it('shows only the items whose permission the predicate grants', () => {
    const labels = labelsWith((p) => p === 'customer.read');
    expect(labels).toContain('Customers');
    expect(labels).not.toContain('Leads');
    expect(labels).not.toContain('Verification');
  });

  it('passes the item permission string to the predicate', () => {
    const asked: string[] = [];
    visibleGroups(false, (p) => {
      asked.push(p);
      return true;
    });
    expect(asked).toEqual(
      expect.arrayContaining([
        'customer.read',
        'crm.lead.read',
        'crm.opportunity.read',
        'quotation.read',
        'verification.read',
        'sales_order.read',
        'invoice.read',
        'payment.read',
        'ar.read',
      ]),
    );
  });
});

describe('ownsPath', () => {
  it('matches the page and the pages under it, not a lookalike', () => {
    expect(ownsPath('/inbox', '/inbox')).toBe(true);
    expect(ownsPath('/inbox', '/inbox/123')).toBe(true);
    expect(ownsPath('/inbox', '/inbox-archive')).toBe(false);
    expect(ownsPath('/', '/')).toBe(true);
    expect(ownsPath('/', '/inbox')).toBe(false);
  });
});

describe('searchNavGroups', () => {
  it('searches group and page labels without surfacing unavailable destinations', () => {
    expect(searchNavGroups(visibleGroups(false), '  INBOX ')).toEqual([
      { label: 'Work', items: [expect.objectContaining({ href: '/inbox' })] },
    ]);
    expect(searchNavGroups(visibleGroups(false), 'organization')).toEqual([]);
    expect(searchNavGroups(visibleGroups(true), 'organization')).toEqual([]);
    expect(
      searchNavGroups(visibleGroups(true), 'settings')[0]?.items.map((item) => item.label),
    ).toEqual(['Settings']);
    expect(searchNavGroups(NAV_GROUPS, 'department')).toEqual([]);
  });

  it('gives a nested page to its own item only (the sales VAT register is not also Invoices)', () => {
    expect(ownsPath('/invoices', '/invoices/abc')).toBe(true);
    expect(ownsPath('/invoices', '/invoices/vat-register')).toBe(false);
    expect(ownsPath('/invoices/vat-register', '/invoices/vat-register')).toBe(true);
  });
});
