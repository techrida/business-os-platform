// Pure unit tests for the Access Settings dry-run evaluator: triggers every single warning
// W1 through W9 with exact severity checks, verifies server-added expansions (resetRole, head
// demotion), impact buckets, and plain-language Check a person "Why" explanations.
import {
  ACCESS_SETTING_AREA_KEYS,
  PERMISSIONS,
  ROLE_KEYS,
  type AccessAssignmentRule,
  type AccessGrantRow,
  type AccessLevelRule,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_LEVEL_RULES, defaultScopeFor } from './access-catalogue';
import {
  type AccessSnapshot,
  evaluateAccessChanges,
  explainAreaAccess,
} from './access-evaluator';

const FORBIDDEN_WORDS = /\b(scopes?|grants?|rbac|seeded|permission key)\b/i;

const DEPT_SALES = '00000000-0000-4000-8000-000000000011';
const DEPT_MKT = '00000000-0000-4000-8000-000000000012';
const USER_FOUNDER = '00000000-0000-4000-8000-000000000101';
const USER_SALES_STAFF = '00000000-0000-4000-8000-000000000102';
const USER_SALES_HEAD = '00000000-0000-4000-8000-000000000103';
const USER_SALES_MGR = '00000000-0000-4000-8000-000000000104';
const USER_ACCOUNTANT = '00000000-0000-4000-8000-000000000105';

function makeSnapshot(overrides: Partial<AccessSnapshot> = {}): AccessSnapshot {
  const grants: AccessGrantRow[] = [];
  for (const role of ROLE_KEYS) {
    for (const permission of PERMISSIONS) {
      const def = defaultScopeFor(role, permission);
      grants.push({ role, permission, scope: def, defaultScope: def, isDefault: true });
    }
  }
  const levelRules: AccessLevelRule[] = ACCESS_SETTING_AREA_KEYS.map((area) => ({
    area,
    ...DEFAULT_LEVEL_RULES[area],
    defaults: { ...DEFAULT_LEVEL_RULES[area] },
  }));
  const assignment: AccessAssignmentRule[] = [
    {
      area: 'leads',
      staff: 'self_and_peers',
      managers: 'any_at_or_below',
      handOvers: [
        {
          fromDepartmentId: DEPT_MKT,
          toDepartmentId: DEPT_SALES,
          fromDepartmentName: 'Marketing',
          toDepartmentName: 'Sales',
        },
      ],
      defaults: { staff: 'self_and_peers', managers: 'any_at_or_below', handOvers: [] },
    },
    {
      area: 'opportunities',
      staff: 'self_and_peers',
      managers: 'any_at_or_below',
      handOvers: [
        {
          fromDepartmentId: DEPT_MKT,
          toDepartmentId: DEPT_SALES,
          fromDepartmentName: 'Marketing',
          toDepartmentName: 'Sales',
        },
      ],
      defaults: { staff: 'self_and_peers', managers: 'any_at_or_below', handOvers: [] },
    },
  ];
  return {
    grants,
    levelRules,
    assignment,
    users: [
      {
        id: USER_FOUNDER,
        name: 'Kiran Thapa',
        email: 'kiran@example.test',
        status: 'active',
        roles: ['founder'],
        departmentId: null,
        level: 'staff',
        jobTitle: null,
        inEntity: true,
      },
      {
        id: USER_SALES_STAFF,
        name: 'Bibek Rai',
        email: 'bibek@example.test',
        status: 'active',
        roles: ['sales'],
        departmentId: DEPT_SALES,
        level: 'staff',
        jobTitle: 'Sales Rep',
        inEntity: true,
      },
      {
        id: USER_SALES_HEAD,
        name: 'Asha Karki',
        email: 'asha@example.test',
        status: 'active',
        roles: ['sales'],
        departmentId: DEPT_SALES,
        level: 'head',
        jobTitle: 'Head of Sales',
        inEntity: true,
      },
      {
        id: USER_SALES_MGR,
        name: 'Chandra Tamang',
        email: 'chandra@example.test',
        status: 'active',
        roles: ['sales'],
        departmentId: DEPT_SALES,
        level: 'manager',
        jobTitle: 'Sales Manager',
        inEntity: true,
      },
      {
        id: USER_ACCOUNTANT,
        name: 'Deepa Gurung',
        email: 'deepa@example.test',
        status: 'active',
        roles: ['accountant'],
        departmentId: DEPT_MKT,
        level: 'staff',
        jobTitle: 'Accountant',
        inEntity: true,
      },
    ],
    departments: [
      { id: DEPT_SALES, name: 'Sales', headUserId: USER_SALES_HEAD },
      { id: DEPT_MKT, name: 'Marketing', headUserId: null },
    ],
    openOwnedCounts: new Map([[`${USER_SALES_STAFF}:leads`, 12]]),
    ...overrides,
  };
}

describe('evaluateAccessChanges warnings W1 through W9', () => {
  it('triggers W1 (blocked) when attempting to edit or reset the Founder role', () => {
    const res = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'founder', permission: 'crm.lead.read', scope: 'own' },
    ]);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ code: 'W1', severity: 'blocked' }),
    );
    expect(res.fieldErrors['changes.0.role']).toBeTruthy();

    const resetRes = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'resetRole', role: 'founder' },
    ]);
    expect(resetRes.warnings).toContainEqual(
      expect.objectContaining({ code: 'W1', severity: 'blocked' }),
    );
  });

  it('triggers W2 (blocked) when giving admin.roles.write to a non-Founder role', () => {
    const res = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'management', permission: 'admin.roles.write', scope: 'all' },
    ]);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ code: 'W2', severity: 'blocked' }),
    );
    expect(res.fieldErrors['changes.0.permission']).toBeTruthy();
  });

  it('triggers W3 (confirm) when giving an administration permission like invite users to a staff role', () => {
    const res = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'sales', permission: 'admin.users.invite', scope: 'all' },
    ]);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ code: 'W3', severity: 'confirm', people: 3 }),
    );
    expect(res.warnings[0]?.message).not.toMatch(FORBIDDEN_WORDS);
  });

  it('triggers W4 (confirm) when a role gains both sides of a maker-checker pair', () => {
    // Accountant already holds payment.record by default; adding payment.verify creates the conflict.
    const res = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'accountant', permission: 'payment.verify', scope: 'all' },
    ]);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ code: 'W4', severity: 'confirm', people: 1 }),
    );
    expect(res.warnings.find((w) => w.code === 'W4')?.message).toContain(
      'Accountant could both record and verify a payment',
    );
  });

  it('triggers W5 (confirm) when a role with active people gains Everything on an area or cost & margin', () => {
    const res = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'all' },
    ]);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ code: 'W5', severity: 'confirm', people: 3 }),
    );

    const costRes = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'accountant', permission: 'quotation.cost.read', scope: 'all' },
    ]);
    // Accountant already has quotation.cost.read by default; test a role without it (operations_head).
    expect(costRes.warnings.filter((w) => w.code === 'W5')).toHaveLength(0);

    const snap = makeSnapshot();
    snap.users[4]!.roles = ['operations_head'];
    const costRes2 = evaluateAccessChanges(snap, [
      { kind: 'grant', role: 'operations_head', permission: 'quotation.cost.read', scope: 'all' },
    ]);
    expect(costRes2.warnings).toContainEqual(
      expect.objectContaining({ code: 'W5', severity: 'confirm', people: 1 }),
    );
  });

  it('triggers W6 (confirm) when no non-Founder role sees an area or a department loses all heads and managers', () => {
    const snap = makeSnapshot();
    const removeAllLeadReaders = ROLE_KEYS.filter(
      (r) => r !== 'founder' && defaultScopeFor(r, 'crm.lead.read') !== null,
    ).map((role) => ({
      kind: 'grant' as const,
      role,
      permission: 'crm.lead.read' as const,
      scope: null,
    }));
    const areaRes = evaluateAccessChanges(snap, removeAllLeadReaders);
    expect(areaRes.warnings).toContainEqual(
      expect.objectContaining({ code: 'W6', severity: 'confirm' }),
    );
    expect(areaRes.warnings.find((w) => w.code === 'W6')?.message).toContain(
      'Only Founders will be able to see leads.',
    );

    // Demoting both the head and manager of Sales leaves no department head or manager.
    const deptRes = evaluateAccessChanges(snap, [
      { kind: 'memberLevel', departmentId: DEPT_SALES, userId: USER_SALES_HEAD, level: 'staff' },
      { kind: 'memberLevel', departmentId: DEPT_SALES, userId: USER_SALES_MGR, level: 'staff' },
    ]);
    expect(deptRes.warnings).toContainEqual(
      expect.objectContaining({ code: 'W6', severity: 'confirm' }),
    );
    expect(deptRes.warnings.find((w) => w.code === 'W6')?.message).toContain("Sales's work");
  });

  it('triggers W7 (confirm) when narrowing access prevents active people from opening open records they own', () => {
    const res = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: null },
    ]);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ code: 'W7', severity: 'confirm', people: 1, records: 12 }),
    );
    expect(res.warnings.find((w) => w.code === 'W7')?.message).toContain('12 leads');
  });

  it('triggers W8 (info) when an action permission stays wider than the see permission on the same area', () => {
    const res = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'sales', permission: 'crm.lead.write', scope: 'department' },
    ]);
    expect(res.warnings).toContainEqual(expect.objectContaining({ code: 'W8', severity: 'info' }));
  });

  it('triggers W9 (blocked) when giving a portal permission to a staff role or a staff permission to a portal role', () => {
    const staffToPortal = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'sales', permission: 'portal.quotation.read', scope: 'customer_org' },
    ]);
    expect(staffToPortal.warnings).toContainEqual(
      expect.objectContaining({ code: 'W9', severity: 'blocked' }),
    );

    const portalToStaff = evaluateAccessChanges(makeSnapshot(), [
      { kind: 'grant', role: 'customer_user', permission: 'crm.lead.read', scope: 'own' },
    ]);
    expect(portalToStaff.warnings).toContainEqual(
      expect.objectContaining({ code: 'W9', severity: 'blocked' }),
    );
  });
});

describe('evaluateAccessChanges expansions, impact, and Why explanations', () => {
  it('expands resetRole into server-added grant lines and demotes previous head to manager', () => {
    const snap = makeSnapshot();
    const salesLead = snap.grants.find(
      (g) => g.role === 'sales' && g.permission === 'crm.lead.read',
    )!;
    salesLead.scope = 'all';
    salesLead.isDefault = false;

    const resetRes = evaluateAccessChanges(snap, [{ kind: 'resetRole', role: 'sales' }]);
    expect(resetRes.applied).toEqual([
      {
        label: 'Sales · See leads',
        from: 'Everything',
        to: 'Their own',
        serverAdded: true,
      },
    ]);
    expect(resetRes.impact.narrowed.people).toBe(3);
    expect(resetRes.impact.widened.people).toBe(0);

    // Promoting Bibek to head of Sales automatically demotes Asha to manager (serverAdded: true).
    const headRes = evaluateAccessChanges(snap, [
      { kind: 'head', departmentId: DEPT_SALES, userId: USER_SALES_STAFF },
    ]);
    expect(headRes.applied).toContainEqual(
      expect.objectContaining({
        from: 'Head',
        to: 'Manager',
        serverAdded: true,
      }),
    );
    expect(headRes.impact.widened.names).toContain('Bibek Rai');
  });

  it('produces plain-language Why lines naming the role and level without forbidden words', () => {
    const snap = makeSnapshot();
    const grantMap = new Map(snap.grants.map((g) => [`${g.role}:${g.permission}`, g.scope]));
    const levelMap = new Map(snap.levelRules.map((l) => [l.area, l]));

    const staffWhy = explainAreaAccess(snap.users[1]!, 'leads', grantMap, levelMap);
    expect(staffWhy).toEqual(['Sales role gives Their own.']);

    const mgrWhy = explainAreaAccess(snap.users[3]!, 'leads', grantMap, levelMap);
    expect(mgrWhy).toEqual([
      'Sales role gives Their own.',
      'Manager level adds Their department.',
    ]);

    const headWhy = explainAreaAccess(snap.users[2]!, 'leads', grantMap, levelMap);
    expect(headWhy).toEqual([
      'Sales role gives Their own.',
      'Department head level adds Their department.',
    ]);

    for (const line of [...staffWhy, ...mgrWhy, ...headWhy]) {
      expect(line).not.toMatch(FORBIDDEN_WORDS);
    }
  });
});
