// Plain-language summaries for Access > By area (spec 3.3) and "Who can assign" (spec 6.3 + R5).
// Pure functions over live grants, level rules, and assignment config; never reads hardcoded defaults
// (D29) and never emits internal vocabulary ("scope", "grant", "RBAC", "seeded", permission keys).
import type {
  AccessAssignmentRule,
  AccessGrantRow,
  AccessLevelRule,
  AccessScope,
  AccessSettingAreaKey,
  RoleKey,
} from '@bos/contracts';

import {
  ACCESS_AREA_CATALOGUE,
  ACCESS_ROLE_CATALOGUE,
  AREA_PLURAL_NOUN,
  roleLabel,
} from './access-catalogue';

function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/**
 * Generates plain-language summary sentences for each of the 9 areas from the live grants and level rules.
 * Every sentence uses business vocabulary only.
 */
export function buildAreaSummaries(
  grants: readonly AccessGrantRow[],
  levelRules: readonly AccessLevelRule[],
): Record<AccessSettingAreaKey, string[]> {
  const grantMap = new Map<string, AccessScope | null>();
  for (const row of grants) {
    grantMap.set(`${row.role}:${row.permission}`, row.scope);
  }
  const levelMap = new Map<AccessSettingAreaKey, AccessLevelRule>(
    levelRules.map((rule) => [rule.area, rule]),
  );

  const staffRoles: RoleKey[] = ACCESS_ROLE_CATALOGUE.filter((r) => r.kind === 'staff').map(
    (r) => r.key,
  );

  const out = {} as Record<AccessSettingAreaKey, string[]>;

  for (const area of ACCESS_AREA_CATALOGUE) {
    const noun = AREA_PLURAL_NOUN[area.key];
    const sentences: string[] = [];

    const allRoles: string[] = [];
    const deptRoles: string[] = [];
    const ownRoles: string[] = [];
    const assignedRoles: string[] = [];

    for (const role of staffRoles) {
      const scope = grantMap.get(`${role}:${area.seePermission}`) ?? null;
      const label = roleLabel(role);
      if (scope === 'all') allRoles.push(label);
      else if (scope === 'department') deptRoles.push(label);
      else if (scope === 'own') ownRoles.push(label);
      else if (scope === 'assigned') assignedRoles.push(label);
    }

    const level = levelMap.get(area.key);

    if (allRoles.length > 0) {
      sentences.push(`Founders, ${joinList(allRoles)} see all ${noun}.`);
    } else {
      sentences.push(`Only Founders see all ${noun}.`);
    }

    if (deptRoles.length > 0) {
      sentences.push(`${joinList(deptRoles)} see their department's ${noun}.`);
    }

    if (ownRoles.length > 0) {
      const levelPhrase =
        area.supportsDepartment && level
          ? level.managersSeeDepartment && level.headsSeeDepartment
            ? ' Their managers and heads see their department.'
            : level.headsSeeDepartment
              ? ' Their heads see their department.'
              : level.managersSeeDepartment
                ? ' Their managers see their department.'
                : ''
          : '';
      sentences.push(`${joinList(ownRoles)} see their own ${noun}.${levelPhrase}`);
    } else if (area.supportsDepartment && level) {
      if (level.managersSeeDepartment && level.headsSeeDepartment) {
        sentences.push(`Department managers and heads see their department's ${noun}.`);
      } else if (level.headsSeeDepartment) {
        sentences.push(`Department heads see their department's ${noun}.`);
      } else if (level.managersSeeDepartment) {
        sentences.push(`Department managers see their department's ${noun}.`);
      }
    }

    if (assignedRoles.length > 0) {
      sentences.push(`${joinList(assignedRoles)} see only ${noun} given to them.`);
    }

    if (area.key === 'quotations') {
      const costRoles = staffRoles
        .filter((role) => (grantMap.get(`${role}:quotation.cost.read`) ?? null) !== null)
        .map(roleLabel);
      if (costRoles.length > 0) {
        sentences.push(`Founders and ${joinList(costRoles)} can see cost and margin.`);
      } else {
        sentences.push('Only Founders can see cost and margin.');
      }
    }

    out[area.key] = sentences;
  }

  return out;
}

/**
 * Generates a one-paragraph plain-language summary for each area's assignment rules (spec 6.3 + R3, R5).
 */
export function buildAssignmentSummaries(
  assignmentRules: readonly AccessAssignmentRule[],
): Record<string, string> {
  const summaries: Record<string, string> = {};

  for (const rule of assignmentRules) {
    const parts: string[] = [];

    if (rule.staff === 'self_only') {
      parts.push('Staff can assign only to themselves.');
    } else if (rule.staff === 'any_at_or_below') {
      parts.push('Staff can assign to anyone in their department at or below their level.');
    } else {
      parts.push('Staff can assign to themselves and same-level colleagues in their department.');
    }

    if (rule.managers === 'self_and_staff') {
      parts.push(
        'Managers and heads can assign only to themselves and people below their level.',
      );
    } else {
      parts.push(
        'Managers and heads can assign to anyone in their department at or below their level.',
      );
    }

    const activePairs = rule.handOvers.filter((p) => !p.fromRetired && !p.toRetired);
    if (activePairs.length > 0) {
      const pairLabels = activePairs.map(
        (p) => `${p.fromDepartmentName ?? 'Department'} to ${p.toDepartmentName ?? 'Department'}`,
      );
      parts.push(
        `Hand-overs are allowed from ${joinList(pairLabels)} (at the same level or below).`,
      );
    } else {
      parts.push('No cross-department hand-overs are enabled.');
    }

    parts.push('Founders can assign to anyone. Nobody can assign upward.');
    summaries[rule.area] = parts.join(' ');
  }

  summaries.quotations = 'Quotations follow their opportunity.';
  return summaries;
}
