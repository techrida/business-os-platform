// Reads the entity's persisted assignment rules and cross-department hand-over pairs
// (migration 0085_assignment_rules) with D50 defaults for unconfigured entities.
// Used by Access Settings read, preview, save, and Check a person; lead-assignment-rule.ts stays pure.
import {
  ASSIGNMENT_AREA_KEYS,
  type AccessAssignmentRule,
  type AssignmentAreaKey,
  type AssignmentHandOver,
  type ManagerAssignmentRule,
  type StaffAssignmentRule,
} from '@bos/contracts';
import { sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import type { AssignmentRuleConfig } from '../leads/lead-assignment-rule';

export type AssignmentQueryable = Db | DbTransaction;

const DEFAULT_STAFF_RULE: StaffAssignmentRule = 'self_and_peers';
const DEFAULT_MANAGER_RULE: ManagerAssignmentRule = 'any_at_or_below';

type DeptRow = {
  id: string;
  name: string;
};

/**
 * Loads the assignment configuration for every assignment-enabled area (`leads`, `opportunities`)
 * in the acting entity. An area without a row in `app.access_assignment_rules` returns D50 defaults
 * including the `Marketing -> Sales` hand-over pair whenever both departments exist in this entity.
 */
export async function loadAssignmentConfig(
  q: AssignmentQueryable,
  scope: TxScope,
): Promise<AccessAssignmentRule[]> {
  const db = q as Db;

  const [rulesRes, handOversRes, deptsRes] = await Promise.all([
    db.execute<{
      area: AssignmentAreaKey;
      staffRule: StaffAssignmentRule;
      managersRule: ManagerAssignmentRule;
    }>(sql`
      SELECT area, staff_rule AS "staffRule", managers_rule AS "managersRule"
        FROM app.access_assignment_rules
       WHERE tenant_id = ${scope.tenantId} AND organization_id = ${scope.organizationId}
    `),
    db.execute<{
      area: AssignmentAreaKey;
      fromDepartmentId: string;
      toDepartmentId: string;
    }>(sql`
      SELECT area,
             from_department_id AS "fromDepartmentId",
             to_department_id AS "toDepartmentId"
        FROM app.access_assignment_handovers
       WHERE tenant_id = ${scope.tenantId} AND organization_id = ${scope.organizationId}
       ORDER BY area, from_department_id, to_department_id
    `),
    db.execute<DeptRow>(sql`
      SELECT id, name
        FROM app.departments
       WHERE tenant_id = ${scope.tenantId} AND organization_id = ${scope.organizationId}
       ORDER BY lower(name), id
    `),
  ]);

  const depts = deptsRes.rows;
  const deptById = new Map(depts.map((d) => [d.id, d]));

  // Default Marketing -> Sales pair when both departments exist by name in this entity.
  const marketingDept = depts.find((d) => d.name.trim().toLowerCase() === 'marketing');
  const salesDept = depts.find((d) => d.name.trim().toLowerCase() === 'sales');
  const defaultHandOvers: AssignmentHandOver[] =
    marketingDept && salesDept && marketingDept.id !== salesDept.id
      ? [
          {
            fromDepartmentId: marketingDept.id,
            toDepartmentId: salesDept.id,
            fromDepartmentName: marketingDept.name,
            toDepartmentName: salesDept.name,
          },
        ]
      : [];

  const ruleByArea = new Map(rulesRes.rows.map((r) => [r.area, r]));
  const handOversByArea = new Map<AssignmentAreaKey, AssignmentHandOver[]>();
  for (const row of handOversRes.rows) {
    const list = handOversByArea.get(row.area) ?? [];
    const fromDept = deptById.get(row.fromDepartmentId);
    const toDept = deptById.get(row.toDepartmentId);
    list.push({
      fromDepartmentId: row.fromDepartmentId,
      toDepartmentId: row.toDepartmentId,
      ...(fromDept === undefined ? {} : { fromDepartmentName: fromDept.name }),
      ...(toDept === undefined ? {} : { toDepartmentName: toDept.name }),
    });
    handOversByArea.set(row.area, list);
  }

  return ASSIGNMENT_AREA_KEYS.map((area) => {
    const saved = ruleByArea.get(area);
    const configured = saved !== undefined;
    return {
      area,
      staff: saved?.staffRule ?? DEFAULT_STAFF_RULE,
      managers: saved?.managersRule ?? DEFAULT_MANAGER_RULE,
      handOvers: configured ? (handOversByArea.get(area) ?? []) : defaultHandOvers,
      defaults: {
        staff: DEFAULT_STAFF_RULE,
        managers: DEFAULT_MANAGER_RULE,
        handOvers: defaultHandOvers,
      },
    };
  });
}

/**
 * Converts a loaded `AccessAssignmentRule` into the pure `AssignmentRuleConfig` consumed by
 * `decideAssignment` and `assignableTargets`.
 */
export function toAssignmentRuleConfig(
  rule: AccessAssignmentRule | undefined,
  useExplicitHandOvers = true,
): AssignmentRuleConfig | undefined {
  if (!rule) return undefined;
  return {
    staff: rule.staff,
    managers: rule.managers,
    ...(useExplicitHandOvers
      ? {
          handOvers: rule.handOvers.map(({ fromDepartmentId, toDepartmentId }) => ({
            fromDepartmentId,
            toDepartmentId,
          })),
        }
      : {}),
  };
}
