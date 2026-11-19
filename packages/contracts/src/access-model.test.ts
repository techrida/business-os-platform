// The default access model (D50, D51) as data: the target table, the default base and level grants that must
// reproduce it, the copy of the level grants migration 0088 embeds, and the assignment rule's vocabulary.
// What stays a todo here: each cell checked against the real API as a seeded user, which needs the real
// interceptor, role cache and live rows (the API e2e matrix).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACCESS_AREAS,
  ACCESS_LEVEL_RANK,
  ACCESS_LEVELS,
  ACCESS_REACH_RANK,
  ACCESS_SCOPE_RANK,
  ACCESS_SCOPES,
  type AccessLevel,
  AccessLevelSchema,
  type AccessReach,
  type AccessScope,
  AccessScopeSchema,
  ASSIGNMENT_ALLOW_LABELS,
  ASSIGNMENT_ALLOW_REASONS,
  ASSIGNMENT_DENY_MESSAGES,
  ASSIGNMENT_DENY_REASONS,
  AssignmentPolicySchema,
  DEFAULT_ASSIGNMENT_POLICY,
  DEFAULT_ROLE_PERMISSION_LEVELS,
  LEAD_INTAKE_ROLE_KEYS,
  LEVEL_GRANT_MIN_LEVELS,
  levelAtLeast,
  MARKETING_ROLE_KEY,
  SALES_ROLE_KEY,
  SENIOR_ASSIGNMENT_REACHES,
  STAFF_ASSIGNMENT_REACHES,
  TARGET_LEAD_ACCESS,
} from './access-model.js';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  PERMISSIONS,
  ROLE_KEYS,
  type RoleKey,
  SCOPES,
} from './authz.js';

const PORTAL_ROLES: readonly RoleKey[] = ['customer_user', 'vendor_user'];

/**
 * What a member of `role` at `level` gets for `permission` from the defaults: the wider of the base grant and the
 * most senior level row at or below their level (a level row only widens). Undefined: no grant.
 */
function effectiveScope(
  role: RoleKey,
  permission: Permission,
  level: AccessLevel,
): AccessScope | undefined {
  const base = DEFAULT_ROLE_PERMISSIONS[role][permission];
  const senior = DEFAULT_ROLE_PERMISSION_LEVELS[role]
    .filter((row) => row.permission === permission && levelAtLeast(level, row.minLevel))
    .sort((a, b) => ACCESS_LEVEL_RANK[b.minLevel] - ACCESS_LEVEL_RANK[a.minLevel])[0];
  const candidates = [base, senior?.scope].filter(
    (scope): scope is AccessScope => scope !== undefined,
  );
  return candidates.sort((a, b) => ACCESS_SCOPE_RANK[b] - ACCESS_SCOPE_RANK[a])[0];
}

/** How a target reach is stored: `created` is `own`, because own read on leads covers what the caller created (K1). */
const STORED_READ: Readonly<Record<AccessReach, AccessScope | undefined>> = {
  none: undefined,
  created: 'own',
  own: 'own',
  department: 'department',
  all: 'all',
};

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

  it('ranks assigned below own below department below customer_org below all', () => {
    const order = [...ACCESS_SCOPES].sort((a, b) => ACCESS_SCOPE_RANK[a] - ACCESS_SCOPE_RANK[b]);
    expect(order).toEqual(['assigned', 'own', 'department', 'customer_org', 'all']);
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
    for (const role of [SALES_ROLE_KEY, MARKETING_ROLE_KEY] as const) {
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
    for (const level of ACCESS_LEVELS) {
      expect(TARGET_LEAD_ACCESS.management[level]).toMatchObject({
        create: false,
        read: 'all',
        write: 'none',
        assigned: false,
      });
    }
  });

  it('lets Finance, Accountant and PMO start leads and read, not edit, what they started', () => {
    for (const role of LEAD_INTAKE_ROLE_KEYS) {
      for (const level of ACCESS_LEVELS) {
        expect(TARGET_LEAD_ACCESS[role][level]).toMatchObject({
          create: true,
          read: 'created',
          write: 'none',
        });
      }
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
      expect(assigned, role).toBe(role === SALES_ROLE_KEY || role === MARKETING_ROLE_KEY);
    }
  });
});

describe('the default grants reproduce the target table', () => {
  // Stored terms: `created` is `own` (own read covers what the caller created). A role that creates needs
  // crm.lead.write to call create, so a target write of `none` with create is stored `own`: the intake roles
  // must give the lead a Sales owner (`sales_owner_required`), so their own write reaches nothing.
  it.each(ROLE_KEYS)('%s, at every level', (role) => {
    for (const level of ACCESS_LEVELS) {
      const cell = TARGET_LEAD_ACCESS[role][level];
      const label = `${role} ${level}`;
      expect(effectiveScope(role, 'crm.lead.read', level), `${label} read`).toBe(
        STORED_READ[cell.read],
      );
      const write = cell.write === 'none' && cell.create ? 'own' : STORED_READ[cell.write];
      expect(effectiveScope(role, 'crm.lead.write', level), `${label} write`).toBe(write);
      expect(effectiveScope(role, 'crm.lead.write', level) !== undefined, `${label} create`).toBe(
        cell.create,
      );
      if (cell.assigned) {
        expect(effectiveScope(role, 'crm.lead.read', level), `${label} assigned`).toBeDefined();
      }
    }
  });

  it('lets opportunities follow their lead for every role but Marketing, which has none', () => {
    for (const role of ROLE_KEYS) {
      for (const level of ACCESS_LEVELS) {
        const opportunity = effectiveScope(role, 'crm.opportunity.read', level);
        const lead = effectiveScope(role, 'crm.lead.read', level);
        if (role === MARKETING_ROLE_KEY) expect(opportunity, level).toBeUndefined();
        else expect(opportunity, `${role} ${level}`).toBe(lead);
      }
    }
  });

  it('moves Finance, Accountant and PMO from every lead to what they started and keeps their other reads (K2)', () => {
    for (const role of LEAD_INTAKE_ROLE_KEYS) {
      const grants = DEFAULT_ROLE_PERMISSIONS[role];
      expect(grants['crm.lead.read'], role).toBe('own');
      expect(grants['crm.opportunity.read'], role).toBe('own');
      expect(grants['crm.lead.write'], role).toBe('own');
      expect(grants['quotation.read'], role).toBe('all');
      expect(grants['customer.read'], role).toBe('all');
      expect(grants['verification.read'], role).toBe('all');
    }
  });

  it('takes leads and opportunities away from Operations Head and keeps its other reads (K2)', () => {
    const grants = DEFAULT_ROLE_PERMISSIONS.operations_head;
    expect(grants['crm.lead.read']).toBeUndefined();
    expect(grants['crm.opportunity.read']).toBeUndefined();
    expect(grants['quotation.read']).toBe('all');
    expect(grants['customer.read']).toBe('all');
    expect(grants['verification.read']).toBe('all');
  });
});

describe('default level grants (K3)', () => {
  it('has an entry for every role, none for the Founder or the portal roles', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSION_LEVELS).sort()).toEqual([...ROLE_KEYS].sort());
    for (const role of ['founder', ...PORTAL_ROLES] as const) {
      expect(DEFAULT_ROLE_PERMISSION_LEVELS[role], role).toEqual([]);
    }
  });

  it('only ever widens: every row reaches further than the base grant', () => {
    for (const role of ROLE_KEYS) {
      for (const row of DEFAULT_ROLE_PERMISSION_LEVELS[role]) {
        const base = DEFAULT_ROLE_PERMISSIONS[role][row.permission];
        const label = `${role} ${row.permission} ${row.minLevel}`;
        if (base !== undefined) {
          expect(ACCESS_SCOPE_RANK[row.scope], label).toBeGreaterThan(ACCESS_SCOPE_RANK[base]);
        }
      }
    }
  });

  it('gives a role a base grant before a level row, except the purchase requests every head reads', () => {
    for (const role of ROLE_KEYS) {
      for (const row of DEFAULT_ROLE_PERMISSION_LEVELS[role]) {
        if (row.permission === 'procurement.pr.read') continue;
        expect(DEFAULT_ROLE_PERMISSIONS[role][row.permission], `${role} ${row.permission}`).toBe(
          'own',
        );
      }
    }
  });

  it('names each permission and level at most once per role (the table is unique on them)', () => {
    for (const role of ROLE_KEYS) {
      const keys = DEFAULT_ROLE_PERMISSION_LEVELS[role].map((r) => `${r.permission}@${r.minLevel}`);
      expect(new Set(keys).size, role).toBe(keys.length);
    }
  });

  it('lets every staff head read the department purchase requests unless the role already reads further', () => {
    for (const role of ROLE_KEYS) {
      if (role === 'founder' || PORTAL_ROLES.includes(role)) continue;
      const scope = effectiveScope(role, 'procurement.pr.read', 'head');
      expect(scope, role).toBeDefined();
      expect(ACCESS_SCOPE_RANK[scope!], role).toBeGreaterThanOrEqual(ACCESS_SCOPE_RANK.department);
      expect(effectiveScope(role, 'procurement.pr.read', 'staff'), role).toBe(
        DEFAULT_ROLE_PERMISSIONS[role]['procurement.pr.read'],
      );
    }
  });

  it('lets a head read the whole department in every area the role reads at own (D51)', () => {
    for (const role of ROLE_KEYS) {
      for (const area of ACCESS_AREAS) {
        if (!('readPermission' in area)) continue;
        const intakeCrm =
          (LEAD_INTAKE_ROLE_KEYS as readonly RoleKey[]).includes(role) &&
          (area.readPermission === 'crm.lead.read' ||
            area.readPermission === 'crm.opportunity.read');
        if (DEFAULT_ROLE_PERMISSIONS[role][area.readPermission] !== 'own' || intakeCrm) continue;
        expect(effectiveScope(role, area.readPermission, 'head'), `${role} ${area.key}`).toBe(
          'department',
        );
      }
    }
  });

  it('gives Sales managers the department on leads, opportunities and quotations, and Sales staff nothing more', () => {
    for (const permission of [
      'crm.lead.write',
      'crm.opportunity.write',
      'quotation.draft',
      'quotation.revise',
    ] as const) {
      expect(effectiveScope('sales', permission, 'staff'), permission).toBe('own');
      expect(effectiveScope('sales', permission, 'manager'), permission).toBe('department');
      expect(effectiveScope('sales', permission, 'head'), permission).toBe('department');
    }
  });
});

describe('migration 0088 level grants', () => {
  // A migration cannot import code, so 0088 embeds the default level rows as a frozen copy. If the defaults change,
  // a new migration is needed for the existing tenants; this test makes the drift visible instead of silent.
  const sql = readFileSync(
    join(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../db/migrations/0088_access_phase2_grants.sql',
    ),
    'utf8',
  );

  // The JSON holds no single quote, so `[^']*` stays inside one SQL string literal.
  const recordset = (alias: string): unknown => {
    const match = new RegExp(`jsonb_to_recordset\\('(\\[[^']*\\])'::jsonb\\) AS ${alias}\\(`).exec(
      sql,
    );
    expect(match, alias).not.toBeNull();
    return JSON.parse(match![1]!);
  };

  it('embeds exactly DEFAULT_ROLE_PERMISSION_LEVELS', () => {
    const rows = recordset('level_grant') as {
      role: string;
      permission: string;
      min_level: string;
      scope: string;
    }[];
    const embedded = rows.map(
      (row) => `${row.role} ${row.permission} ${row.min_level} ${row.scope}`,
    );
    const expected = ROLE_KEYS.flatMap((role) =>
      DEFAULT_ROLE_PERMISSION_LEVELS[role].map(
        (row) => `${role} ${row.permission} ${row.minLevel} ${row.scope}`,
      ),
    );
    expect([...embedded].sort()).toEqual([...expected].sort());
  });

  it('adds Marketing only rows its defaults hold', () => {
    const rows = recordset('marketing_grant') as { permission: Permission; scope: string }[];
    expect(rows.map((row) => row.permission).sort()).toEqual([
      'customer.read',
      'profile.avatar.write',
    ]);
    for (const row of rows) {
      expect(DEFAULT_ROLE_PERMISSIONS.marketing[row.permission], row.permission).toBe(row.scope);
    }
  });
});

describe('Marketing defaults', () => {
  const grants = DEFAULT_ROLE_PERMISSIONS.marketing;

  it('creates, reads and edits its own leads', () => {
    expect(grants['crm.lead.read']).toBe('own');
    expect(grants['crm.lead.write']).toBe('own');
  });

  it('reads only the customers it owns, and sets its own profile picture (D55-6)', () => {
    expect(grants['customer.read']).toBe('own');
    expect(grants['profile.avatar.write']).toBe('own');
  });

  it('has no quotation, opportunity, customer change or approval-acting grant', () => {
    const forbidden = Object.keys(grants).filter(
      (p) =>
        p !== 'customer.read' &&
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

describe('assignment vocabulary (K6)', () => {
  it('has a message for every refusal and a label for every allowance', () => {
    expect(Object.keys(ASSIGNMENT_DENY_MESSAGES).sort()).toEqual(
      [...ASSIGNMENT_DENY_REASONS].sort(),
    );
    expect(Object.keys(ASSIGNMENT_ALLOW_LABELS).sort()).toEqual(
      [...ASSIGNMENT_ALLOW_REASONS].sort(),
    );
  });

  it('names the codes the access settings and the pickers share', () => {
    expect(ASSIGNMENT_ALLOW_REASONS).toContain('handover');
    for (const code of [
      'no_handover',
      'self_only',
      'same_level',
      'cannot_read_subject',
      'not_active_staff',
    ] as const) {
      expect(ASSIGNMENT_DENY_REASONS).toContain(code);
    }
  });

  it('keeps product words in the messages: no internal keys', () => {
    for (const text of [
      ...Object.values(ASSIGNMENT_DENY_MESSAGES),
      ...Object.values(ASSIGNMENT_ALLOW_LABELS),
    ]) {
      expect(text).not.toMatch(/scope|grant|_|\./);
    }
  });

  it('defaults to the first option of each setting and hands Marketing to Sales (D50, spec 6.3)', () => {
    expect(AssignmentPolicySchema.parse(DEFAULT_ASSIGNMENT_POLICY)).toEqual(
      DEFAULT_ASSIGNMENT_POLICY,
    );
    expect(DEFAULT_ASSIGNMENT_POLICY.staff).toBe(STAFF_ASSIGNMENT_REACHES[0]);
    expect(DEFAULT_ASSIGNMENT_POLICY.managers).toBe(SENIOR_ASSIGNMENT_REACHES[0]);
    expect(DEFAULT_ASSIGNMENT_POLICY.handOvers).toEqual([
      { from: MARKETING_ROLE_KEY, to: SALES_ROLE_KEY },
    ]);
  });

  it('refuses a hand-over naming an unknown role', () => {
    expect(
      AssignmentPolicySchema.safeParse({
        ...DEFAULT_ASSIGNMENT_POLICY,
        handOvers: [{ from: 'marketing', to: 'galaxy' }],
      }).success,
    ).toBe(false);
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
