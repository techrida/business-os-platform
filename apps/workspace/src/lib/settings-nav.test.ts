import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { permissionChecker } from '@/components/p2/customers/permissions';

import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  canOpenSection,
  firstAllowedSection,
  sectionForPath,
  settingsSection,
  visibleSettingsGroups,
} from './settings-nav';

const founder = permissionChecker(['founder']);
const sales = permissionChecker(['sales']);
const labels = (can: ((p: string) => boolean) | undefined) =>
  visibleSettingsGroups(can).flatMap((g) => g.sections.map((s) => s.label));

describe('SETTINGS_GROUPS', () => {
  it('lists the twelve sections of the plan in four groups, in order', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual([
      'Company',
      'People and access',
      'Finance',
      'Sales and purchasing',
    ]);
    expect(SETTINGS_SECTIONS.map((s) => s.href)).toEqual([
      '/settings/company',
      '/settings/documents',
      '/settings/formats',
      '/settings/terms',
      '/settings/users',
      '/settings/roles',
      '/settings/workflows',
      '/settings/currencies',
      '/settings/tax',
      '/settings/numbering',
      '/settings/sales',
      '/settings/purchasing',
    ]);
  });

  it('has unique ids, hrefs and labels, and a description for every section', () => {
    for (const key of ['id', 'href', 'label'] as const) {
      const values = SETTINGS_SECTIONS.map((s) => s[key]);
      expect(new Set(values).size).toBe(values.length);
    }
    for (const s of SETTINGS_SECTIONS) expect(s.description.length, s.id).toBeGreaterThan(10);
  });

  it('never links to a page that does not exist: every ready section has its page.tsx', () => {
    const root = join(process.cwd(), 'src', 'app', '(app)');
    for (const section of SETTINGS_SECTIONS) {
      const page = join(root, section.href, 'page.tsx');
      if (section.ready) expect(existsSync(page), section.href).toBe(true);
    }
  });

  it('keeps the four new Company sections out of the menu until they are ready', () => {
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

  it('shows a section for any one of its permissions and omits groups left empty', () => {
    const groups = visibleSettingsGroups((p) => p === 'approvals.groups.write');
    expect(groups.map((g) => g.label)).toEqual(['People and access']);
    expect(groups[0]?.sections.map((s) => s.label)).toEqual(['Approval workflows']);
  });

  it('hides a ready section that is switched back to not ready', () => {
    const section = settingsSection('tax');
    expect(canOpenSection(section, founder)).toBe(true);
    expect(canOpenSection({ ...section, permission: [] }, founder)).toBe(false);
  });
});

describe('sections and paths', () => {
  it('finds the first allowed section, or none', () => {
    expect(firstAllowedSection(founder)?.href).toBe('/settings/company');
    expect(firstAllowedSection(sales)).toBeUndefined();
    expect(firstAllowedSection((p) => p === 'admin.settings.write')?.href).toBe(
      '/settings/company',
    );
  });

  it('maps a nested path to its section and ignores lookalikes', () => {
    expect(sectionForPath('/settings/users/new')?.id).toBe('users');
    expect(sectionForPath('/settings/users')?.id).toBe('users');
    expect(sectionForPath('/settings/usersx')).toBeUndefined();
    expect(sectionForPath('/settings')).toBeUndefined();
  });
});
