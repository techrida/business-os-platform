import { describe, expect, it } from 'vitest';

import { NAV_GROUPS, SHIPPED_PHASES, isBuilt, ownsPath, titleForPath, visibleGroups } from './nav';

const items = NAV_GROUPS.flatMap((group) => group.items);

describe('NAV_GROUPS', () => {
  it('lists the Figma groups in order', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      'Overview',
      'Work',
      'Administration',
      'Organization',
      'CRM',
      'Sales Management',
      'Sales',
      'Payments',
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

  it('gives an absolute href to every built item, and only shipped phases are built', () => {
    for (const item of items) {
      if (isBuilt(item)) {
        expect(item.href, item.label).toMatch(/^\//);
        expect(SHIPPED_PHASES, item.label).toContain(item.phase);
      } else {
        expect(item.href, item.label).toBeUndefined();
      }
    }
  });

  it('never builds an item from a phase that has not shipped', () => {
    for (const item of items.filter((i) => !SHIPPED_PHASES.includes(i.phase))) {
      expect(isBuilt(item), item.label).toBe(false);
    }
  });

  it('builds the P0 to P3 pages', () => {
    const built = items.filter(isBuilt);
    expect(built.map((i) => [i.label, i.href])).toEqual([
      ['Overview', '/'],
      ['Inbox', '/inbox'],
      ['Memos', '/memos'],
      ['Users', '/admin/users'],
      ['Roles & Permissions', '/admin/roles'],
      ['Approval Workflows', '/admin/workflows'],
      ['Customers', '/customers'],
      ['Leads', '/leads'],
      ['Opportunities', '/opportunities'],
      ['Quotations', '/quotations'],
      ['Verification', '/verification'],
      ['Activities & Tasks', '/activities'],
      ['Sales Orders', '/sales-orders'],
      ['Invoices', '/invoices'],
      ['Payments', '/payments'],
      ['Receivables', '/receivables/aging'],
      ['Settings', '/admin/settings'],
    ]);
  });

  it('gates every P3 billing page by its read permission', () => {
    const permissionByLabel = Object.fromEntries(
      items.filter((i) => i.phase === 'P3' && isBuilt(i)).map((i) => [i.label, i.permission]),
    );
    expect(permissionByLabel).toEqual({
      'Sales Orders': 'sales_order.read',
      Invoices: 'invoice.read',
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

  it('marks every /admin page as admin-only, and nothing else', () => {
    for (const item of items) {
      const isAdminPage = item.href?.startsWith('/admin') ?? false;
      expect(item.audience === 'admin', item.label).toBe(isAdminPage);
    }
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

  it('uses only known phases', () => {
    const phases = new Set(['P0', 'P1', 'P2', 'P3', 'P4', 'later']);
    for (const item of items) expect(phases.has(item.phase), item.label).toBe(true);
  });
});

describe('visibleGroups', () => {
  const labelsFor = (showAdmin: boolean) =>
    visibleGroups(showAdmin).flatMap((g) => g.items.map((i) => i.label));

  it('hides the admin screens and the empty Administration group from non-admins', () => {
    expect(visibleGroups(false).map((g) => g.label)).not.toContain('Administration');
    expect(labelsFor(false)).not.toContain('Users');
    expect(labelsFor(false)).not.toContain('Settings');
    expect(labelsFor(false)).toContain('Inbox');
    expect(labelsFor(false)).toContain('Help');
  });

  it('shows them to admins', () => {
    expect(visibleGroups(true).map((g) => g.label)).toContain('Administration');
    expect(labelsFor(true)).toEqual(expect.arrayContaining(['Users', 'Settings']));
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

describe('titleForPath', () => {
  it('names the built page', () => {
    expect(titleForPath('/')).toBe('Overview');
    expect(titleForPath('/inbox')).toBe('Inbox');
  });

  it('names a page under a built page by its owner', () => {
    expect(titleForPath('/inbox/0f3a')).toBe('Inbox');
    expect(titleForPath('/memos/new')).toBe('Memos');
    expect(titleForPath('/admin/users/invite')).toBe('Users');
  });

  it('names the P2 pages and the pages under them', () => {
    expect(titleForPath('/customers')).toBe('Customers');
    expect(titleForPath('/customers/0f3a/edit')).toBe('Customers');
    expect(titleForPath('/verification/0f3a')).toBe('Verification');
  });

  it('names the P3 billing pages and the pages under them', () => {
    expect(titleForPath('/sales-orders')).toBe('Sales Orders');
    expect(titleForPath('/invoices/0f3a')).toBe('Invoices');
    expect(titleForPath('/payments/0f3a')).toBe('Payments');
    expect(titleForPath('/receivables/aging')).toBe('Receivables');
  });

  it('falls back to the app name for any other path', () => {
    expect(titleForPath('/somewhere-else')).toBe('Business OS');
  });
});
