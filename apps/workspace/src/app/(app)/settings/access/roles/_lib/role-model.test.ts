import type { AccessRoleInfo, RoleKey } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { isRoleEdited, orderRoles, roleGroups, undoLabel, type PermissionRow } from './role-model';
import { testCatalogue } from './test-catalogue';

const catalogue = testCatalogue();
const role = (key: RoleKey): AccessRoleInfo => {
  const found = catalogue.roles.find((r) => r.key === key);
  if (!found) throw new Error(`no role ${key}`);
  return found;
};
const rowsOf = (key: RoleKey) => roleGroups(catalogue, role(key)).flatMap((g) => g.rows);
const row = (key: RoleKey, permission: string): PermissionRow => {
  const found = rowsOf(key).find((r) => r.permission === permission);
  if (!found) throw new Error(`no row ${permission}`);
  return found;
};

describe('roleGroups', () => {
  it('keeps the catalogue group order and leaves the portal group out of a staff role', () => {
    expect(roleGroups(catalogue, role('sales')).map((g) => g.key)).toEqual([
      'leads',
      'invoices',
      'administration',
    ]);
  });

  it('shows a portal role only its portal permissions, as checkboxes', () => {
    const groups = roleGroups(catalogue, role('customer_user'));
    expect(groups.map((g) => g.key)).toEqual(['portal']);
    const [only] = groups[0]?.rows ?? [];
    expect(only?.control).toBe('checkbox');
    expect(only?.onValue).toBe('customer_org');
    expect(only?.options).toEqual([]);
  });

  it('uses a reach select for record permissions and a checkbox for on/off ones', () => {
    expect(row('sales', 'crm.lead.read').control).toBe('select');
    expect(row('sales', 'invoice.issue').control).toBe('checkbox');
    expect(row('sales', 'invoice.issue').onValue).toBe('all');
  });

  it('offers only the reaches the API lists for that permission', () => {
    expect(row('sales', 'invoice.read').options.map((o) => o.value)).toEqual(['', 'own', 'all']);
    expect(row('sales', 'crm.lead.read').options.map((o) => o.value)).toEqual([
      '',
      'assigned',
      'own',
      'department',
      'all',
    ]);
  });

  it('carries the saved value, the default, the risk note and separation of duties', () => {
    const leads = row('sales', 'crm.lead.read');
    expect(leads.saved).toBe('department');
    expect(leads.defaultScope).toBe('own');
    expect(row('sales', 'admin.users.invite').risk).toBe(
      'Lets this role add people to the company.',
    );
    expect(row('sales', 'invoice.issue').separationOfDuties).toBe(true);
  });
});

describe('isRoleEdited', () => {
  it('is true only when a saved value differs from its default', () => {
    expect(isRoleEdited(catalogue, 'sales')).toBe(true);
    expect(isRoleEdited(catalogue, 'operations_head')).toBe(false);
  });
});

describe('orderRoles', () => {
  it('puts Founder first, staff roles by name, and portal roles apart', () => {
    const { main, portal } = orderRoles(catalogue.roles);
    expect(main.map((r) => r.label)).toEqual(['Founder', 'Management', 'Operations head', 'Sales']);
    expect(portal.map((r) => r.label)).toEqual(['Customer portal user', 'Vendor portal user']);
  });
});

describe('undoLabel', () => {
  it('names what it resets, for which role, and to what', () => {
    expect(undoLabel('Sales', row('sales', 'crm.lead.read'))).toBe(
      'Reset See leads for Sales to the default: Their own',
    );
    expect(undoLabel('Sales', row('sales', 'invoice.issue'))).toBe(
      'Reset Issue an invoice for Sales to the default: Off',
    );
  });
});
