import type { AccessRoleInfo } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  currentReach,
  differsFromDefault,
  filterGroups,
  grantChanges,
  roleGroups,
  stageReach,
  type PermissionRow,
  type StagedReach,
} from './role-model';
import { testCatalogue } from './test-catalogue';

const catalogue = testCatalogue();
const sales = catalogue.roles.find((r) => r.key === 'sales') as AccessRoleInfo;
const groups = roleGroups(catalogue, sales);
const row = (permission: string): PermissionRow =>
  groups.flatMap((g) => g.rows).find((r) => r.permission === permission) as PermissionRow;

describe('staging unsaved choices', () => {
  it('shows the saved value until something is chosen', () => {
    expect(currentReach(row('crm.lead.read'), {})).toBe('department');
  });

  it('stages a new value and drops it again when the saved value is chosen back', () => {
    const leads = row('crm.lead.read');
    const staged = stageReach({}, leads, 'all');
    expect(currentReach(leads, staged)).toBe('all');
    expect(stageReach(staged, leads, 'department')).toEqual({});
  });

  it('stages Nothing as null, which removes the grant', () => {
    const staged = stageReach({}, row('crm.lead.write'), null);
    expect(grantChanges('sales', groups, staged)).toEqual([
      { kind: 'grant', role: 'sales', permission: 'crm.lead.write', scope: null },
    ]);
  });

  it('builds one grant change per unsaved choice, in row order', () => {
    let staged: StagedReach = {};
    staged = stageReach(staged, row('invoice.issue'), 'all');
    staged = stageReach(staged, row('crm.lead.read'), 'own');
    expect(grantChanges('sales', groups, staged)).toEqual([
      { kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'own' },
      { kind: 'grant', role: 'sales', permission: 'invoice.issue', scope: 'all' },
    ]);
  });

  it('draws the undo icon only while the shown value differs from the default', () => {
    const leads = row('crm.lead.read');
    expect(differsFromDefault(leads, {})).toBe(true);
    expect(differsFromDefault(leads, stageReach({}, leads, 'own'))).toBe(false);
    expect(differsFromDefault(row('crm.lead.write'), {})).toBe(false);
  });
});

describe('filterGroups', () => {
  it('finds a permission by any word of its label or group', () => {
    const found = filterGroups(groups, {}, { query: 'invoice issue', onlyGranted: false });
    expect(found.map((g) => g.key)).toEqual(['invoices']);
    expect(found[0]?.rows.map((r) => r.permission)).toEqual(['invoice.issue']);
  });

  it('finds a permission by its risk note', () => {
    const found = filterGroups(groups, {}, { query: 'add people', onlyGranted: false });
    expect(found[0]?.rows.map((r) => r.permission)).toEqual(['admin.users.invite']);
  });

  it('hides what the role cannot do, counting unsaved choices', () => {
    expect(
      filterGroups(groups, {}, { query: '', onlyGranted: true }).flatMap((g) =>
        g.rows.map((r) => r.permission),
      ),
    ).toEqual(['crm.lead.read', 'crm.lead.write']);
    const staged = stageReach({}, row('invoice.read'), 'own');
    expect(
      filterGroups(groups, staged, { query: '', onlyGranted: true }).map((g) => g.key),
    ).toEqual(['leads', 'invoices']);
  });
});
