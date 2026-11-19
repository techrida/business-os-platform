// Pure unit tests for the Access Settings catalogue and plain-language summaries:
// covers all 68 PERMISSIONS, all 13 ROLE_KEYS, all 9 areas, scope filtering rules (R2, R3),
// default-grant validity, and Spec section 9 plain-language vocabulary rules.
import {
  ACCESS_SETTING_AREA_KEYS,
  DEFAULT_ROLE_PERMISSION_LEVELS,
  DEFAULT_ROLE_PERMISSIONS,
  LEVEL_RULE_AREAS,
  PERMISSIONS,
  ROLE_KEYS,
  type AccessAssignmentRule,
  type AccessGrantRow,
  type AccessLevelRule,
  type LevelRuleArea,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_AREA_CATALOGUE,
  ACCESS_CONFLICTS,
  ACCESS_PERMISSION_CATALOGUE,
  ACCESS_PERMISSION_GROUPS,
  ACCESS_ROLE_CATALOGUE,
  DEFAULT_LEVEL_RULES,
  PERMISSION_BY_KEY,
  defaultScopeFor,
  impliedLevelRows,
  isScopeAllowedForRole,
  levelRulePermissions,
  reachLabel,
} from './access-catalogue';
import { buildAreaSummaries, buildAssignmentSummaries } from './access-summaries';

const FORBIDDEN_WORDS = /\b(scopes?|grants?|rbac|seeded|permission key)\b/i;

function defaultGrants(): AccessGrantRow[] {
  const rows: AccessGrantRow[] = [];
  for (const role of ROLE_KEYS) {
    for (const permission of PERMISSIONS) {
      const def = defaultScopeFor(role, permission);
      rows.push({ role, permission, scope: def, defaultScope: def, isDefault: true });
    }
  }
  return rows;
}

function defaultLevelRules(): AccessLevelRule[] {
  return ACCESS_SETTING_AREA_KEYS.map((area) => ({
    area,
    ...DEFAULT_LEVEL_RULES[area],
    defaults: { ...DEFAULT_LEVEL_RULES[area] },
  }));
}

describe('access-catalogue completeness', () => {
  it('lists every role in ROLE_KEYS once, locking only founder', () => {
    expect(ACCESS_ROLE_CATALOGUE.map((r) => r.key).sort()).toEqual([...ROLE_KEYS].sort());
    expect(ACCESS_ROLE_CATALOGUE.filter((r) => r.locked).map((r) => r.key)).toEqual(['founder']);
  });

  it('lists every permission in PERMISSIONS once in the catalogue and once across groups', () => {
    const catalogueKeys = ACCESS_PERMISSION_CATALOGUE.map((p) => p.key);
    expect(catalogueKeys).toHaveLength(PERMISSIONS.length);
    expect([...catalogueKeys].sort()).toEqual([...PERMISSIONS].sort());

    const groupKeys = ACCESS_PERMISSION_GROUPS.flatMap((g) => g.permissions);
    expect(groupKeys).toHaveLength(PERMISSIONS.length);
    expect([...groupKeys].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('covers all 9 areas with exact department and assignment flags (spec 3.1, R2, R3)', () => {
    expect(ACCESS_AREA_CATALOGUE.map((a) => a.key)).toEqual([...ACCESS_SETTING_AREA_KEYS]);
    expect(ACCESS_AREA_CATALOGUE.filter((a) => a.hasAssignment).map((a) => a.key)).toEqual([
      'leads',
      'opportunities',
    ]);
    expect(ACCESS_AREA_CATALOGUE.find((a) => a.key === 'quotations')?.followsArea).toBe(
      'opportunities',
    );
    expect(ACCESS_AREA_CATALOGUE.filter((a) => a.supportsDepartment).map((a) => a.key)).toEqual([
      'leads',
      'opportunities',
      'quotations',
      'procurement',
    ]);
  });

  it('offers the assigned scope only on crm.lead.read and crm.opportunity.read (spec 3.2)', () => {
    const withAssigned = ACCESS_PERMISSION_CATALOGUE.filter(
      (p) => p.scopesFor.staff.includes('assigned') || p.scopesFor.portal.includes('assigned'),
    ).map((p) => p.key);
    expect(withAssigned).toEqual(['crm.lead.read', 'crm.opportunity.read']);
  });

  it('never offers staff scopes to portal roles or portal scopes to staff roles', () => {
    for (const perm of ACCESS_PERMISSION_CATALOGUE) {
      if (perm.kind === 'portal') {
        expect(perm.scopesFor.staff).toEqual([]);
        expect(perm.scopesFor.portal).toEqual(['customer_org']);
      } else {
        expect(perm.scopesFor.portal).toEqual([]);
        expect(perm.scopesFor.staff).not.toContain('customer_org');
      }
    }
  });

  it('permits every default grant in DEFAULT_ROLE_PERMISSIONS under isScopeAllowedForRole', () => {
    for (const role of ROLE_KEYS) {
      const grants = DEFAULT_ROLE_PERMISSIONS[role];
      for (const [permission, scope] of Object.entries(grants)) {
        expect(
          isScopeAllowedForRole(role, permission as (typeof PERMISSIONS)[number], scope ?? null),
          `${role} ${permission} ${String(scope)}`,
        ).toBe(true);
      }
    }
  });

  it('keeps user-facing catalogue strings free of internal vocabulary (spec 9)', () => {
    const texts: string[] = [
      ...ACCESS_ROLE_CATALOGUE.flatMap((r) => [r.label, r.description]),
      ...ACCESS_AREA_CATALOGUE.map((a) => a.label),
      ...ACCESS_PERMISSION_GROUPS.map((g) => g.label),
      ...ACCESS_PERMISSION_CATALOGUE.flatMap((p) => (p.risk ? [p.label, p.risk] : [p.label])),
      ...ACCESS_CONFLICTS.map((c) => c.message),
      reachLabel(null, 'record'),
      reachLabel(null, 'onOff'),
      reachLabel('assigned', 'record'),
      reachLabel('own', 'record'),
      reachLabel('department', 'record'),
      reachLabel('customer_org', 'portal'),
      reachLabel('all', 'record'),
      reachLabel('all', 'onOff'),
    ];
    for (const text of texts) {
      expect(text, `forbidden word in "${text}"`).not.toMatch(FORBIDDEN_WORDS);
    }
  });
});

describe('department-reach switches agree with the contracts', () => {
  const areas: readonly LevelRuleArea[] = LEVEL_RULE_AREAS;

  it('takes see permissions, department support and default switches from LEVEL_RULE_AREAS', () => {
    expect(
      ACCESS_AREA_CATALOGUE.map((a) => [a.key, a.seePermission, a.supportsDepartment]),
    ).toEqual(areas.map((a) => [a.key, a.seePermission, a.supportsDepartment]));
    expect(DEFAULT_LEVEL_RULES).toEqual(
      Object.fromEntries(
        areas.map((a) => [
          a.key,
          {
            managersSeeDepartment: a.managersSeeDepartment,
            headsSeeDepartment: a.headsSeeDepartment,
          },
        ]),
      ),
    );
  });

  it('pairs only the leads and opportunities edit permissions with their switch', () => {
    expect(levelRulePermissions('leads')).toEqual(['crm.lead.read', 'crm.lead.write']);
    expect(levelRulePermissions('opportunities')).toEqual([
      'crm.opportunity.read',
      'crm.opportunity.write',
    ]);
    expect(levelRulePermissions('quotations')).toEqual(['quotation.read']);
    expect(levelRulePermissions('procurement')).toEqual(['procurement.pr.read']);
    expect(levelRulePermissions('invoices')).toEqual([]);
  });

  it('implies exactly DEFAULT_ROLE_PERMISSION_LEVELS from the default grants and switches', () => {
    const grantMap = new Map(
      defaultGrants().map((g) => [`${g.role}:${g.permission}`, g.scope] as const),
    );
    const implied = impliedLevelRows(grantMap, defaultLevelRules())
      .map((r) => `${r.role} ${r.permission} ${r.minLevel} department`)
      .sort();
    const expected = ROLE_KEYS.flatMap((role) =>
      DEFAULT_ROLE_PERMISSION_LEVELS[role].map(
        (r) => `${role} ${r.permission} ${r.minLevel} ${r.scope}`,
      ),
    ).sort();
    expect(implied).toEqual(expected);
    // The intake roles start leads for Sales but never edit them, so no switch widens their write.
    expect(implied).not.toContain('finance crm.lead.write manager department');
    expect(implied).toContain('sales crm.lead.write manager department');
  });
});

describe('access-summaries', () => {
  it('renders plain-language summaries for every area and reflects live edits (D29)', () => {
    const grants = defaultGrants();
    const levels = defaultLevelRules();
    const before = buildAreaSummaries(grants, levels);

    for (const area of ACCESS_SETTING_AREA_KEYS) {
      expect(before[area].length).toBeGreaterThan(0);
      for (const sentence of before[area]) {
        expect(sentence).not.toMatch(FORBIDDEN_WORDS);
      }
    }
    expect(before.leads.join(' ')).toContain('Sales and Marketing see their own leads.');
    expect(before.leads.join(' ')).toContain('Their managers and heads see their department.');

    // A head with no head row keeps the manager row at run time, so the manager switch alone still
    // reaches heads and the summary says so.
    const managersOnly = defaultLevelRules().map((rule) =>
      rule.area === 'leads' ? { ...rule, headsSeeDepartment: false } : rule,
    );
    expect(buildAreaSummaries(grants, managersOnly).leads.join(' ')).toContain(
      'Their managers and heads see their department.',
    );
    const headsOnly = defaultLevelRules().map((rule) =>
      rule.area === 'leads' ? { ...rule, managersSeeDepartment: false } : rule,
    );
    expect(buildAreaSummaries(grants, headsOnly).leads.join(' ')).toContain(
      'Their heads see their department.',
    );

    // Editing live grants changes the summary immediately (proving it does not read hardcoded defaults).
    const salesLead = grants.find((g) => g.role === 'sales' && g.permission === 'crm.lead.read')!;
    salesLead.scope = 'all';
    const after = buildAreaSummaries(grants, levels);
    expect(after.leads[0]).toContain('Sales');
    expect(PERMISSION_BY_KEY.get('crm.lead.read')?.kind).toBe('record');
  });

  it('renders plain-language assignment summaries including R3 and R5 wording', () => {
    const rules: AccessAssignmentRule[] = [
      {
        area: 'leads',
        staff: 'self_only',
        managers: 'self_and_staff',
        handOvers: [
          {
            fromDepartmentId: '00000000-0000-4000-8000-000000000010',
            toDepartmentId: '00000000-0000-4000-8000-000000000020',
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
        handOvers: [],
        defaults: { staff: 'self_and_peers', managers: 'any_at_or_below', handOvers: [] },
      },
    ];
    const summaries = buildAssignmentSummaries(rules);
    expect(summaries.leads).toContain('Staff can assign only to themselves.');
    expect(summaries.leads).toContain(
      'Managers and heads can assign only to themselves and people below their level.',
    );
    expect(summaries.leads).toContain('Marketing to Sales');
    expect(summaries.quotations).toBe('Quotations follow their opportunity.');
    for (const sentence of Object.values(summaries)) {
      expect(sentence).not.toMatch(FORBIDDEN_WORDS);
    }
  });
});
