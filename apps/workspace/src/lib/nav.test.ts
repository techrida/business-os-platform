import { describe, expect, it } from 'vitest';

import { BUILT_PHASE, NAV_GROUPS, isBuilt, titleForPath } from './nav';

const items = NAV_GROUPS.flatMap((group) => group.items);

describe('NAV_GROUPS', () => {
  it('lists the Figma groups in order', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      'Overview',
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

  it('gives an href to built items only, and it is an absolute path', () => {
    for (const item of items) {
      if (item.phase === BUILT_PHASE) {
        expect(item.href, item.label).toMatch(/^\//);
      } else {
        expect(item.href, item.label).toBeUndefined();
      }
    }
  });

  it('builds only Overview in P0', () => {
    const built = items.filter(isBuilt);
    expect(built.map((i) => [i.label, i.href])).toEqual([['Overview', '/']]);
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

describe('titleForPath', () => {
  it('names the built page', () => {
    expect(titleForPath('/')).toBe('Overview');
  });

  it('falls back to the app name for any other path', () => {
    expect(titleForPath('/somewhere-else')).toBe('Business OS');
  });
});
