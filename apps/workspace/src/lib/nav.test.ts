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

  it('builds the P0 and P1 pages', () => {
    const built = items.filter(isBuilt);
    expect(built.map((i) => [i.label, i.href])).toEqual([
      ['Overview', '/'],
      ['Inbox', '/inbox'],
      ['Memos', '/memos'],
      ['Users', '/admin/users'],
      ['Roles & Permissions', '/admin/roles'],
      ['Approval Workflows', '/admin/workflows'],
      ['Settings', '/admin/settings'],
    ]);
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

  it('falls back to the app name for any other path', () => {
    expect(titleForPath('/somewhere-else')).toBe('Business OS');
  });
});
