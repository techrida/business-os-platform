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
  it('lists the thirteen sub-tabs across four left-hand sections in order', () => {
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
      '/settings/currencies',
      '/settings/tax',
      '/settings/numbering',
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

  it('keeps the four Company sub-tabs gated on admin.settings.write', () => {
    const company = SETTINGS_SECTIONS.filter((s) =>
      ['company', 'documents', 'formats', 'terms'].includes(s.id),
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
