import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { permissionChecker } from '@/components/p2/customers/permissions';

import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  canOpenSection,
  firstAllowedInGroup,
  firstAllowedSection,
  groupForPath,
  sectionForPath,
  settingsGroup,
  settingsSection,
  visibleSettingsGroups,
} from './settings-nav';

const founder = permissionChecker(['founder']);
const sales = permissionChecker(['sales']);
const labels = (can: ((p: string) => boolean) | undefined) =>
  visibleSettingsGroups(can).flatMap((g) => g.sections.map((s) => s.label));

describe('SETTINGS_GROUPS', () => {
  it('lists the fifteen sub-tabs across four left-hand sections in order', () => {
    expect(SETTINGS_GROUPS.map((g) => [g.id, g.label, g.href])).toEqual([
      ['company-setup', 'Company', '/settings/company-setup'],
      ['organisation', 'Organisation', '/settings/organisation'],
      ['finance', 'Finance', '/settings/finance'],
      ['sales-and-purchasing', 'Sales and purchasing', '/settings/sales-and-purchasing'],
    ]);
    expect(SETTINGS_SECTIONS.map((s) => s.href)).toEqual([
      '/settings/company',
      '/settings/documents',
      '/settings/formats',
      '/settings/terms',
      '/settings/users',
      '/settings/departments',
      '/settings/access',
      '/settings/workflows',
      '/settings/email-delivery',
      '/settings/currencies',
      '/settings/tax',
      '/settings/numbering',
      '/settings/company-accounts',
      '/settings/sales',
      '/settings/purchasing',
    ]);
  });

  it('places every ready leaf in exactly one section with unique ids, labels and non-colliding hrefs', () => {
    const groupIds = SETTINGS_GROUPS.map((g) => g.id);
    const groupHrefs = SETTINGS_GROUPS.map((g) => g.href);
    const groupLabels = SETTINGS_GROUPS.map((g) => g.label);
    expect(new Set(groupIds).size).toBe(groupIds.length);
    expect(new Set(groupHrefs).size).toBe(groupHrefs.length);
    expect(new Set(groupLabels).size).toBe(groupLabels.length);

    for (const key of ['id', 'href', 'label'] as const) {
      const values = SETTINGS_SECTIONS.map((s) => s[key]);
      expect(new Set(values).size).toBe(values.length);
    }

    const leafHrefs = new Set(SETTINGS_SECTIONS.map((s) => s.href));
    for (const group of SETTINGS_GROUPS) {
      expect(leafHrefs.has(group.href), group.href).toBe(false);
      expect(group.description.length, group.id).toBeGreaterThan(10);
    }

    for (const section of SETTINGS_SECTIONS.filter((s) => s.ready)) {
      const owners = SETTINGS_GROUPS.filter((g) => g.sections.some((s) => s.id === section.id));
      expect(owners, section.id).toHaveLength(1);
    }

    for (const s of SETTINGS_SECTIONS) expect(s.description.length, s.id).toBeGreaterThan(10);
  });

  it('never links to a page that does not exist: every section index and ready sub-tab has its page.tsx', () => {
    const root = join(process.cwd(), 'src', 'app', '(app)');
    for (const group of SETTINGS_GROUPS) {
      const indexPage = join(root, group.href, 'page.tsx');
      expect(existsSync(indexPage), group.href).toBe(true);
    }
    for (const section of SETTINGS_SECTIONS) {
      const page = join(root, section.href, 'page.tsx');
      if (section.ready) expect(existsSync(page), section.href).toBe(true);
    }
  });

  it('keeps company profile, templates and formats gated on admin.settings.write alone', () => {
    const company = SETTINGS_SECTIONS.filter((s) =>
      ['company', 'documents', 'formats'].includes(s.id),
    );
    expect(company.every((s) => s.permission === 'admin.settings.write')).toBe(true);
    for (const section of company.filter((s) => !s.ready)) {
      expect(labels(founder)).not.toContain(section.label);
    }
  });
});

describe('visibleSettingsGroups', () => {
  it('shows every ready section to the founder, grouped', () => {
    const ready = SETTINGS_SECTIONS.filter((s) => s.ready).map((s) => s.label);
    expect(labels(founder)).toEqual(ready);
  });

  it('shows nothing to a role without a settings permission, and nothing with no predicate', () => {
    expect(visibleSettingsGroups(sales)).toEqual([]);
    expect(visibleSettingsGroups(undefined)).toEqual([]);
    expect(visibleSettingsGroups(() => false)).toEqual([]);
  });

  it('shows a section for any one of its permissions and omits sections left empty', () => {
    const groups = visibleSettingsGroups((p) => p === 'approvals.groups.write');
    expect(groups.map((g) => g.label)).toEqual(['Organisation']);
    expect(groups[0]?.sections.map((s) => s.label)).toEqual(['Approval workflows']);
  });

  it('hides a ready section that has no matching permission', () => {
    const section = settingsSection('tax');
    expect(canOpenSection(section, founder)).toBe(true);
    expect(canOpenSection({ ...section, permission: [] }, founder)).toBe(false);
  });
});

describe('finance settings opened by live grants (F1-Q48)', () => {
  const live =
    (...held: string[]) =>
    (permission: string) =>
      held.includes(permission);
  // Live grants as Settings > Access stores them; deliberately not the role defaults.
  const finance = live('settings.fx_rate.write', 'settings.finance.write', 'quotation.read');
  const accountant = live('settings.finance.write', 'invoice.read');
  const founderOnly = live('admin.settings.write');

  it('opens Currencies for an exchange-rate grant, and Tax, Numbering, Bank and expense accounts and Saved terms for a finance-settings grant', () => {
    expect(labels(finance)).toEqual([
      'Saved terms',
      'Currencies and exchange rates',
      'Tax',
      'Document numbering',
      'Bank and expense accounts',
    ]);
    expect(canOpenSection(settingsSection('company'), finance)).toBe(false);
    expect(canOpenSection(settingsSection('sales'), finance)).toBe(false);
  });

  it('opens Numbering, Bank and expense accounts and Saved terms but not Currencies for the Accountant', () => {
    expect(labels(accountant)).toEqual([
      'Saved terms',
      'Tax',
      'Document numbering',
      'Bank and expense accounts',
    ]);
    expect(canOpenSection(settingsSection('company-accounts'), accountant)).toBe(true);
    expect(canOpenSection(settingsSection('currencies'), accountant)).toBe(false);
    expect(firstAllowedSection(accountant)?.href).toBe('/settings/terms');
    expect(firstAllowedInGroup('finance', accountant)?.href).toBe('/settings/tax');
  });

  it('opens Currencies alone for an exchange-rate grant without the finance-settings grant', () => {
    expect(labels(live('settings.fx_rate.write'))).toEqual(['Currencies and exchange rates']);
  });

  it('still opens all five for admin.settings.write, and none for a role granted neither', () => {
    for (const id of ['currencies', 'tax', 'numbering', 'company-accounts', 'terms'] as const) {
      expect(canOpenSection(settingsSection(id), founderOnly), id).toBe(true);
      expect(canOpenSection(settingsSection(id), live('quotation.read')), id).toBe(false);
    }
  });
});

describe('sections and paths', () => {
  it('finds the first allowed sub-tab overall and within each section, or none', () => {
    expect(firstAllowedSection(founder)?.href).toBe('/settings/company');
    expect(firstAllowedSection(sales)).toBeUndefined();
    expect(firstAllowedSection((p) => p === 'admin.settings.write')?.href).toBe(
      '/settings/company',
    );
    expect(firstAllowedInGroup('organisation', founder)?.href).toBe('/settings/users');
    expect(firstAllowedInGroup('organisation', (p) => p === 'admin.roles.read')?.href).toBe(
      '/settings/departments',
    );
    expect(firstAllowedInGroup('organisation', (p) => p === 'approvals.groups.write')?.href).toBe(
      '/settings/workflows',
    );
    expect(
      firstAllowedInGroup('organisation', (p) => p === 'admin.settings.write'),
    ).toBeUndefined();
    expect(firstAllowedInGroup('organisation', undefined)).toBeUndefined();
    expect(settingsGroup('organisation').href).toBe('/settings/organisation');
  });

  it('names the Access section and its By role and Check a person pages as one sub-tab', () => {
    expect(settingsSection('roles')).toMatchObject({ label: 'Access', href: '/settings/access' });
    expect(sectionForPath('/settings/access/roles/sales')?.id).toBe('roles');
    expect(sectionForPath('/settings/access/check')?.id).toBe('roles');
    expect(sectionForPath('/settings/departments/abc')?.id).toBe('departments');
  });

  it('maps section index paths and nested sub-tab paths to their owning section', () => {
    expect(groupForPath('/settings/organisation')?.id).toBe('organisation');
    expect(groupForPath('/settings/departments/abc')?.id).toBe('organisation');
    expect(groupForPath('/settings/access/roles')?.id).toBe('organisation');
    expect(groupForPath('/settings/tax')?.id).toBe('finance');
    expect(groupForPath('/settings/company')?.id).toBe('company-setup');
    expect(groupForPath('/settings/sales')?.id).toBe('sales-and-purchasing');
    expect(groupForPath('/settings/usersx')).toBeUndefined();
    expect(groupForPath('/settings')).toBeUndefined();
    expect(groupForPath('/settings/denied')).toBeUndefined();
  });

  it('opens Departments with either users or roles read access', () => {
    const departments = settingsSection('departments');
    expect(canOpenSection(departments, (p) => p === 'admin.users.read')).toBe(true);
    expect(canOpenSection(departments, (p) => p === 'admin.roles.read')).toBe(true);
    expect(canOpenSection(departments, (p) => p === 'admin.settings.write')).toBe(false);
  });

  it('maps a nested path to its section and ignores lookalikes', () => {
    expect(sectionForPath('/settings/users/new')?.id).toBe('users');
    expect(sectionForPath('/settings/users')?.id).toBe('users');
    expect(sectionForPath('/settings/usersx')).toBeUndefined();
    expect(sectionForPath('/settings')).toBeUndefined();
  });
});
