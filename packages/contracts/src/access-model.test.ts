// The default access model (D50, D51) as data: the target table, the default base and level grants that must
// reproduce it, the copies of the grants migrations 0088 and 0123 embed, and the assignment rule's vocabulary.
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
  DEFAULT_ROLE_PERMISSION_LEVELS,
  LEAD_INTAKE_ROLE_KEYS,
  LEVEL_GRANT_MIN_LEVELS,
  LEVEL_RULE_AREAS,
  levelAtLeast,
  type LevelRuleArea,
  MARKETING_ROLE_KEY,
  SALES_ROLE_KEY,
  TARGET_LEAD_ACCESS,
} from './access-model.js';
import { ACCESS_SETTING_AREA_KEYS } from './access-settings.js';
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

  it('lets Sales and Marketing managers and heads see and edit the department, staff only their own (D50)', () => {
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

  it('lets PMO start leads and read, not edit, what it started; its managers and heads see the department (D51)', () => {
    expect(TARGET_LEAD_ACCESS.pmo.staff).toMatchObject({
      create: true,
      read: 'created',
      write: 'none',
    });
    for (const level of ['manager', 'head'] as const) {
      expect(TARGET_LEAD_ACCESS.pmo[level]).toMatchObject({
        create: true,
        read: 'department',
        write: 'none',
      });
    }
  });

  it('lets Finance and Accountant start leads and read every lead at every level, editing none (U20a2-Q4)', () => {
    for (const role of ['finance', 'accountant'] as const) {
      expect(LEAD_INTAKE_ROLE_KEYS as readonly RoleKey[], role).toContain(role);
      for (const level of ACCESS_LEVELS) {
        expect(TARGET_LEAD_ACCESS[role][level], `${role} ${level}`).toEqual({
          create: true,
          read: 'all',
          write: 'none',
          assigned: false,
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

  it('moves PMO from every lead to what it started, gives Finance and Accountant every lead, and keeps their other reads (K2, U20a2-Q4)', () => {
    for (const role of LEAD_INTAKE_ROLE_KEYS) {
      const grants = DEFAULT_ROLE_PERMISSIONS[role];
      const read = role === 'pmo' ? 'own' : 'all';
      expect(grants['crm.lead.read'], role).toBe(read);
      expect(grants['crm.opportunity.read'], role).toBe(read);
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

describe('level rule areas (U20b)', () => {
  it('lists the nine areas of Settings > Access in its order, each with a real see permission', () => {
    expect(LEVEL_RULE_AREAS.map((area) => area.key)).toEqual([...ACCESS_SETTING_AREA_KEYS]);
    for (const area of LEVEL_RULE_AREAS) {
      expect(PERMISSIONS as readonly string[], area.key).toContain(area.seePermission);
    }
  });

  it('pairs an edit permission with the see permission of leads and opportunities only', () => {
    const edits = Object.fromEntries(
      (LEVEL_RULE_AREAS as readonly LevelRuleArea[])
        .filter((area) => area.editPermission !== undefined)
        .map((area) => [area.key, area.editPermission]),
    );
    expect(edits).toEqual({
      leads: 'crm.lead.write',
      opportunities: 'crm.opportunity.write',
    });
  });

  it('agrees with the read permission each record area opens its list with', () => {
    for (const area of ACCESS_AREAS) {
      if (!('readPermission' in area)) continue;
      const rule = LEVEL_RULE_AREAS.find((candidate) => candidate.key === area.key);
      expect(rule?.seePermission, area.key).toBe(area.readPermission);
    }
  });

  it('keeps the default switches of Settings > Access (DEFAULT_LEVEL_RULES)', () => {
    const switches = Object.fromEntries(
      LEVEL_RULE_AREAS.map((area) => [
        area.key,
        [area.supportsDepartment, area.managersSeeDepartment, area.headsSeeDepartment],
      ]),
    );
    expect(switches).toEqual({
      leads: [true, true, true],
      opportunities: [true, true, true],
      quotations: [true, true, true],
      sales_orders: [false, false, false],
      invoices: [false, false, false],
      procurement: [true, false, true],
      payables: [false, false, false],
      approvals: [false, false, false],
      documents: [false, false, false],
    });
  });

  it('never switches department reach on for an area whose records carry no department', () => {
    for (const area of LEVEL_RULE_AREAS) {
      if (area.supportsDepartment) continue;
      expect(area.managersSeeDepartment || area.headsSeeDepartment, area.key).toBe(false);
    }
  });
});

describe('default level grants (U20b materialisation)', () => {
  const allRows = ROLE_KEYS.flatMap((role) =>
    DEFAULT_ROLE_PERMISSION_LEVELS[role].map((row) => ({ role, ...row })),
  );
  const rowKey = (row: (typeof allRows)[number]): string =>
    `${row.role} ${row.permission} ${row.minLevel} ${row.scope}`;

  it('is exactly the rows Settings > Access materialises from the default switches', () => {
    expect(allRows.map(rowKey).sort()).toEqual(
      [
        'sales crm.lead.read manager department',
        'sales crm.lead.read head department',
        'sales crm.opportunity.read manager department',
        'sales crm.opportunity.read head department',
        'sales crm.lead.write manager department',
        'sales crm.lead.write head department',
        'sales crm.opportunity.write manager department',
        'sales crm.opportunity.write head department',
        'sales quotation.read manager department',
        'sales quotation.read head department',
        'marketing crm.lead.read manager department',
        'marketing crm.lead.read head department',
        'marketing crm.lead.write manager department',
        'marketing crm.lead.write head department',
        'pmo crm.lead.read manager department',
        'pmo crm.lead.read head department',
        'pmo crm.opportunity.read manager department',
        'pmo crm.opportunity.read head department',
        'operations_officer procurement.pr.read head department',
      ].sort(),
    );
  });

  it('gives Finance and Accountant no level row (they read every lead), and PMO managers and heads the department (D51)', () => {
    for (const role of ['finance', 'accountant'] as const) {
      expect(DEFAULT_ROLE_PERMISSION_LEVELS[role], role).toEqual([]);
      for (const level of ACCESS_LEVELS) {
        for (const permission of ['crm.lead.read', 'crm.opportunity.read'] as const) {
          expect(effectiveScope(role, permission, level), `${role} ${permission} ${level}`).toBe(
            'all',
          );
        }
      }
    }
    for (const permission of ['crm.lead.read', 'crm.opportunity.read'] as const) {
      expect(effectiveScope('pmo', permission, 'staff'), permission).toBe('own');
      expect(effectiveScope('pmo', permission, 'manager'), permission).toBe('department');
      expect(effectiveScope('pmo', permission, 'head'), permission).toBe('department');
    }
  });

  it('has an entry for every role, none for the Founder or the portal roles', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSION_LEVELS).sort()).toEqual([...ROLE_KEYS].sort());
    for (const role of ['founder', ...PORTAL_ROLES] as const) {
      expect(DEFAULT_ROLE_PERMISSION_LEVELS[role], role).toEqual([]);
    }
  });

  it('names only the see or edit permission of an area with department reach, at a level its switch turns on', () => {
    for (const row of allRows) {
      const area = (LEVEL_RULE_AREAS as readonly LevelRuleArea[]).find(
        (candidate) =>
          candidate.seePermission === row.permission || candidate.editPermission === row.permission,
      );
      const label = `${row.role} ${row.permission} ${row.minLevel}`;
      expect(area, label).toBeDefined();
      expect(area!.supportsDepartment, label).toBe(true);
      expect(
        row.minLevel === 'manager' ? area!.managersSeeDepartment : area!.headsSeeDepartment,
        label,
      ).toBe(true);
      expect(row.scope, label).toBe('department');
    }
  });

  it('gives an edit row only with the see row of the same switch and level', () => {
    for (const row of allRows) {
      const area = (LEVEL_RULE_AREAS as readonly LevelRuleArea[]).find(
        (candidate) => candidate.editPermission === row.permission,
      );
      if (area === undefined) continue;
      const label = `${row.role} ${row.permission} ${row.minLevel}`;
      expect(
        allRows.some(
          (see) =>
            see.role === row.role &&
            see.permission === area.seePermission &&
            see.minLevel === row.minLevel,
        ),
        label,
      ).toBe(true);
    }
  });

  it('never widens the lead or opportunity write of Finance, Accountant or PMO, which only start leads', () => {
    for (const role of LEAD_INTAKE_ROLE_KEYS) {
      for (const permission of ['crm.lead.write', 'crm.opportunity.write'] as const) {
        expect(
          DEFAULT_ROLE_PERMISSION_LEVELS[role].filter((row) => row.permission === permission),
          `${role} ${permission}`,
        ).toEqual([]);
      }
      expect(effectiveScope(role, 'crm.lead.write', 'head'), role).toBe('own');
    }
  });

  it('gives no row on any other write permission and none in an area without a department', () => {
    for (const permission of [
      'quotation.draft',
      'quotation.submit',
      'quotation.send',
      'quotation.record_acceptance',
      'quotation.revise',
      'procurement.pr.create',
      'sales_order.read',
      'invoice.read',
      'payables.bill.read',
      'approvals.requests.read',
      'documents.read',
    ] as const) {
      expect(
        allRows.filter((row) => row.permission === permission).map(rowKey),
        permission,
      ).toEqual([]);
    }
  });

  it('never creates access and only ever widens: every row needs a base grant narrower than the department', () => {
    for (const row of allRows) {
      const base = DEFAULT_ROLE_PERMISSIONS[row.role][row.permission];
      const label = `${row.role} ${row.permission} ${row.minLevel}`;
      expect(base, label).toBeDefined();
      expect(['department', 'all'], label).not.toContain(base);
    }
  });

  it('names each permission and level at most once per role (the table is unique on them)', () => {
    for (const role of ROLE_KEYS) {
      const keys = DEFAULT_ROLE_PERMISSION_LEVELS[role].map((r) => `${r.permission}@${r.minLevel}`);
      expect(new Set(keys).size, role).toBe(keys.length);
    }
  });

  it('gives purchase requests to heads only, and only to a role that already reads its own', () => {
    for (const role of ROLE_KEYS) {
      if (DEFAULT_ROLE_PERMISSIONS[role]['procurement.pr.read'] !== undefined) continue;
      expect(effectiveScope(role, 'procurement.pr.read', 'head'), role).toBeUndefined();
    }
    expect(effectiveScope('operations_officer', 'procurement.pr.read', 'manager')).toBe('own');
    expect(effectiveScope('operations_officer', 'procurement.pr.read', 'head')).toBe('department');
  });

  it('gives Sales managers and heads the department to see, and its leads and opportunities to edit', () => {
    for (const permission of [
      'crm.lead.read',
      'crm.opportunity.read',
      'quotation.read',
      'crm.lead.write',
      'crm.opportunity.write',
    ] as const) {
      expect(effectiveScope('sales', permission, 'staff'), permission).toBe('own');
      expect(effectiveScope('sales', permission, 'manager'), permission).toBe('department');
      expect(effectiveScope('sales', permission, 'head'), permission).toBe('department');
    }
    for (const permission of ['quotation.draft', 'quotation.revise'] as const) {
      for (const level of ACCESS_LEVELS) {
        expect(effectiveScope('sales', permission, level), `${permission} ${level}`).toBe('own');
      }
    }
  });
});

describe('migrations 0088 and 0123 level grants', () => {
  // A migration cannot import code, so 0088 embeds the default level rows as a frozen copy and 0123 the rows it
  // removes and the reads it widens. If the defaults change, a new migration is needed for the existing tenants;
  // these tests make the drift visible instead of silent.
  const migration = (file: string): string =>
    readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), `../../db/migrations/${file}`),
      'utf8',
    );
  const sql = migration('0088_access_phase2_grants.sql');
  const sql0123 = migration('0123_finance_accountant_read_all_crm.sql');

  // The JSON holds no single quote, so `[^']*` stays inside one SQL string literal.
  const recordset = (alias: string, text = sql): unknown => {
    const match = new RegExp(`jsonb_to_recordset\\('(\\[[^']*\\])'::jsonb\\) AS ${alias}\\(`).exec(
      text,
    );
    expect(match, alias).not.toBeNull();
    return JSON.parse(match![1]!);
  };

  interface EmbeddedLevelRow {
    role: RoleKey;
    permission: Permission;
    min_level: string;
    scope: string;
  }
  const levelKey = (row: EmbeddedLevelRow): string =>
    `${row.role} ${row.permission} ${row.min_level} ${row.scope}`;
  const seeded0088 = (recordset('level_grant') as EmbeddedLevelRow[]).map(levelKey);
  const removed0123 = (recordset('removed_level', sql0123) as EmbeddedLevelRow[]).map(levelKey);
  const defaults = ROLE_KEYS.flatMap((role) =>
    DEFAULT_ROLE_PERMISSION_LEVELS[role].map(
      (row) => `${role} ${row.permission} ${row.minLevel} ${row.scope}`,
    ),
  );

  it('0088 less the rows 0123 removes is exactly DEFAULT_ROLE_PERMISSION_LEVELS', () => {
    expect(seeded0088.filter((key) => !removed0123.includes(key)).sort()).toEqual(
      [...defaults].sort(),
    );
  });

  it('0123 removes only rows 0088 seeded, and only for roles whose default now reads every record', () => {
    for (const row of recordset('removed_level', sql0123) as EmbeddedLevelRow[]) {
      const label = levelKey(row);
      expect(seeded0088, label).toContain(label);
      expect(DEFAULT_ROLE_PERMISSIONS[row.role][row.permission], label).toBe('all');
    }
    expect(removed0123.filter((key) => key.startsWith('pmo '))).toEqual([]);
  });

  it('0123 widens exactly the Finance and Accountant reads the defaults hold at `all`', () => {
    const rows = recordset('read_all_grant', sql0123) as {
      role: RoleKey;
      permission: Permission;
      scope: string;
    }[];
    expect(rows.map((row) => `${row.role} ${row.permission} ${row.scope}`).sort()).toEqual(
      [
        'finance crm.lead.read all',
        'finance crm.opportunity.read all',
        'accountant crm.lead.read all',
        'accountant crm.opportunity.read all',
      ].sort(),
    );
    for (const row of rows) {
      expect(DEFAULT_ROLE_PERMISSIONS[row.role][row.permission], row.role).toBe(row.scope);
    }
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

  it("lets its managers and heads edit the department's leads and nothing further", () => {
    for (const level of ['manager', 'head'] as const) {
      expect(effectiveScope('marketing', 'crm.lead.write', level), level).toBe('department');
    }
    expect(effectiveScope('marketing', 'crm.lead.write', 'staff')).toBe('own');
    expect(effectiveScope('marketing', 'crm.opportunity.write', 'head')).toBeUndefined();
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

describe('reopen and company settings defaults (K2, K3)', () => {
  const staffRoles = ROLE_KEYS.filter((role) => role !== 'founder');

  it('gives each reopen at the department to exactly the roles holding the matching write', () => {
    const pairs = [
      ['crm.lead.reopen', 'crm.lead.write'],
      ['crm.opportunity.reopen', 'crm.opportunity.write'],
    ] as const;
    for (const [reopen, write] of pairs) {
      expect(DEFAULT_ROLE_PERMISSIONS.founder[reopen]).toBe('all');
      for (const role of staffRoles) {
        const writes = DEFAULT_ROLE_PERMISSIONS[role][write] !== undefined;
        expect(DEFAULT_ROLE_PERMISSIONS[role][reopen], `${role} ${reopen}`).toBe(
          writes ? 'department' : undefined,
        );
      }
    }
  });

  it('names the roles that reopen leads and opportunities by default', () => {
    const holders = (permission: Permission) =>
      ROLE_KEYS.filter((role) => DEFAULT_ROLE_PERMISSIONS[role][permission] !== undefined);
    expect(holders('crm.lead.reopen')).toEqual([
      'founder',
      'finance',
      'accountant',
      'sales',
      'marketing',
      'pmo',
    ]);
    expect(holders('crm.opportunity.reopen')).toEqual(['founder', 'sales']);
  });

  it('adds no level row on reopen, so the frozen 0088 copy stays exact', () => {
    for (const role of ROLE_KEYS) {
      const reopenRows = DEFAULT_ROLE_PERMISSION_LEVELS[role].filter((row) =>
        row.permission.endsWith('.reopen'),
      );
      expect(reopenRows, role).toEqual([]);
    }
  });

  it('gives Finance both settings writes and the Accountant the finance settings only', () => {
    const holders = (permission: Permission) =>
      ROLE_KEYS.filter((role) => DEFAULT_ROLE_PERMISSIONS[role][permission] !== undefined);
    expect(holders('settings.fx_rate.write')).toEqual(['founder', 'finance']);
    expect(holders('settings.finance.write')).toEqual(['founder', 'finance', 'accountant']);
    expect(holders('admin.settings.write')).toEqual(['founder']);
    for (const permission of ['settings.fx_rate.write', 'settings.finance.write'] as const) {
      for (const role of holders(permission)) {
        expect(DEFAULT_ROLE_PERMISSIONS[role][permission], `${role} ${permission}`).toBe('all');
      }
    }
  });

  it('lists the four new permissions once each', () => {
    for (const permission of [
      'settings.fx_rate.write',
      'settings.finance.write',
      'crm.lead.reopen',
      'crm.opportunity.reopen',
    ] as const) {
      expect(PERMISSIONS.filter((p) => p === permission), permission).toHaveLength(1);
    }
  });
});
