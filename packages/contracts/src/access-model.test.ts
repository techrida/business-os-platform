// Role x area x scope matrix scaffold for the default access model (D50, D51).
// What is real now: the shape of the target table, its consistency rules, and the Marketing role's defaults.
// What is a todo: each cell checked against the real API as a seeded user. Phase 2 turns every todo into a test
// that signs in as the role at that level and lists /leads, opens a record and assigns, and records which cells
// still differ from `DEFAULT_ROLE_PERMISSIONS`.
import { describe, expect, it } from 'vitest';

import {
  ACCESS_AREAS,
  ACCESS_LEVEL_RANK,
  ACCESS_LEVELS,
  ACCESS_REACH_RANK,
  ACCESS_SCOPES,
  AccessLevelSchema,
  AccessScopeSchema,
  LEAD_INTAKE_ROLE_KEYS,
  LEVEL_GRANT_MIN_LEVELS,
  levelAtLeast,
  MARKETING_ROLE_KEY,
  TARGET_LEAD_ACCESS,
} from './access-model.js';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLE_KEYS, SCOPES } from './authz.js';

describe('levels and scopes', () => {
  it('ranks staff below manager below head', () => {
    expect(ACCESS_LEVELS.map((l) => ACCESS_LEVEL_RANK[l])).toEqual([0, 1, 2]);
    expect(levelAtLeast('head', 'manager')).toBe(true);
    expect(levelAtLeast('manager', 'manager')).toBe(true);
    expect(levelAtLeast('staff', 'manager')).toBe(false);
    expect(AccessLevelSchema.safeParse('director').success).toBe(false);
  });

  it('adds only `assigned` to the four scopes the code already enforces', () => {
    expect(ACCESS_SCOPES).toEqual([...SCOPES, 'assigned']);
    expect(AccessScopeSchema.safeParse('assigned').success).toBe(true);
    expect(SCOPES as readonly string[]).not.toContain('assigned');
  });

  it('lets only manager and head carry a level grant', () => {
    expect(LEVEL_GRANT_MIN_LEVELS).toEqual(['manager', 'head']);
  });
});

describe('areas', () => {
  it('names every area once, with a real permission or a parent area', () => {
    const keys = ACCESS_AREAS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const area of ACCESS_AREAS) {
      if ('followsArea' in area) {
        expect(keys).toContain(area.followsArea);
        expect('readPermission' in area).toBe(false);
      } else {
        expect(PERMISSIONS as readonly string[]).toContain(area.readPermission);
      }
    }
  });
});

describe('target lead access (D50)', () => {
  it('has a cell for every role at every level', () => {
    expect(Object.keys(TARGET_LEAD_ACCESS).sort()).toEqual([...ROLE_KEYS].sort());
    for (const role of ROLE_KEYS) {
      expect(Object.keys(TARGET_LEAD_ACCESS[role]).sort()).toEqual([...ACCESS_LEVELS].sort());
    }
  });

  it('never lets a more senior level reach less than a junior one', () => {
    for (const role of ROLE_KEYS) {
      for (const field of ['read', 'write'] as const) {
        const reaches = ACCESS_LEVELS.map(
          (l) => ACCESS_REACH_RANK[TARGET_LEAD_ACCESS[role][l][field]],
        );
        expect(reaches, `${role} ${field}`).toEqual([...reaches].sort((a, b) => a - b));
      }
    }
  });

  it('never writes further than it reads, and creates only where it can read what it made', () => {
    for (const role of ROLE_KEYS) {
      for (const level of ACCESS_LEVELS) {
        const cell = TARGET_LEAD_ACCESS[role][level];
        expect(ACCESS_REACH_RANK[cell.write], `${role} ${level}`).toBeLessThanOrEqual(
          ACCESS_REACH_RANK[cell.read],
        );
        if (cell.create) expect(cell.read, `${role} ${level}`).not.toBe('none');
      }
    }
  });

  it('gives Sales and Marketing staff their own leads and their managers and heads the department', () => {
    for (const role of ['sales', MARKETING_ROLE_KEY] as const) {
      expect(TARGET_LEAD_ACCESS[role].staff).toMatchObject({
        read: 'own',
        write: 'own',
        assigned: true,
      });
      for (const level of ['manager', 'head'] as const) {
        expect(TARGET_LEAD_ACCESS[role][level]).toMatchObject({
          read: 'department',
          write: 'department',
        });
      }
    }
  });

  it('lets Management read everything and change nothing', () => {
    expect(TARGET_LEAD_ACCESS.management.staff).toMatchObject({
      create: false,
      read: 'all',
      write: 'none',
    });
  });

  it('lets Finance, Accountant and PMO start leads and read only what they started', () => {
    for (const role of LEAD_INTAKE_ROLE_KEYS) {
      expect(TARGET_LEAD_ACCESS[role].staff).toMatchObject({ create: true, read: 'created' });
    }
  });

  it('keeps Operations, Procurement, Warehouse and the portal roles out of leads', () => {
    for (const role of [
      'operations_head',
      'procurement',
      'warehouse',
      'operations_officer',
      'customer_user',
      'vendor_user',
    ] as const) {
      expect(TARGET_LEAD_ACCESS[role].head).toMatchObject({
        create: false,
        read: 'none',
        write: 'none',
      });
    }
  });

  it('only ever marks `assigned` on roles that work leads', () => {
    for (const role of ROLE_KEYS) {
      const assigned = ACCESS_LEVELS.some((l) => TARGET_LEAD_ACCESS[role][l].assigned);
      expect(assigned, role).toBe(role === 'sales' || role === MARKETING_ROLE_KEY);
    }
  });
});

describe('Marketing defaults', () => {
  const grants = DEFAULT_ROLE_PERMISSIONS.marketing;

  it('creates, reads and edits its own leads', () => {
    expect(grants['crm.lead.read']).toBe('own');
    expect(grants['crm.lead.write']).toBe('own');
  });

  it('has no quotation, opportunity, customer or approval-acting grant', () => {
    const forbidden = Object.keys(grants).filter((p) =>
      /^(quotation|crm\.opportunity|customer|sales_order|invoice|payment|approvals\.requests\.act)/.test(
        p,
      ),
    );
    expect(forbidden).toEqual([]);
  });

  it('matches the target table at the staff level', () => {
    expect(TARGET_LEAD_ACCESS.marketing.staff.read).toBe(grants['crm.lead.read']);
    expect(TARGET_LEAD_ACCESS.marketing.staff.write).toBe(grants['crm.lead.write']);
  });
});

describe('API matrix (phase 2)', () => {
  it.todo('every role x level lists exactly the leads its cell reaches, as a seeded user');
  it.todo('every role x level reads, edits and refuses a lead of the same cell as the list shows');
  it.todo('assigned reaches a lead read-only: the assignee reads it and cannot edit it');
  it.todo('a department head reads every record of their own department in every area (D51)');
  it.todo(
    'the owner picker lists exactly the people decideAssignment accepts, and a hand-built request to anyone else is a 400',
  );
  it.todo(
    'Finance, Accountant and PMO start a lead for a Sales owner and still read it afterwards',
  );
  it.todo('reseeding keeps a Founder-made grant and refreshes a seeded one');
});
