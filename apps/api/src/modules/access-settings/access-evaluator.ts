// Pure dry-run simulator for Access Settings (spec 7.2, 8.1 W1-W9).
// Takes a point-in-time snapshot of live grants, level rules, assignment rules, active users,
// departments, and open record counts, applies a batch of proposed AccessChange items in memory,
// expands server-added side effects, computes field validation errors, warnings W1-W9, impact
// buckets (widened/narrowed/unchanged), and plain-language Check a person "Why" explanations.
import {
  type AccessAppliedChange,
  type AccessAssignmentRule,
  type AccessChange,
  type AccessGrantRow,
  type AccessImpact,
  type AccessLevel,
  type AccessLevelRule,
  type AccessScope,
  type AccessSettingAreaKey,
  type AccessWarning,
  type AssignmentAreaKey,
  type Permission,
  type RoleKey,
} from '@bos/contracts';

import {
  ACCESS_AREA_CATALOGUE,
  ACCESS_PERMISSION_CATALOGUE,
  ADMIN_CONFIRM_PERMISSIONS,
  AREA_BY_KEY,
  AREA_BY_SEE_PERMISSION,
  AREA_PLURAL_NOUN,
  AREA_SINGULAR_NOUN,
  MAKER_CHECKER_CONFLICTS,
  PERMISSION_BY_KEY,
  ROLE_BY_KEY,
  defaultScopeFor,
  isScopeAllowedForRole,
  managerAssignmentRuleLabel,
  permissionLabel,
  reachLabel,
  reachRank,
  roleLabel,
  staffAssignmentRuleLabel,
} from './access-catalogue';
import { buildAreaSummaries, buildAssignmentSummaries } from './access-summaries';

export interface SnapshotUser {
  id: string;
  name: string;
  email: string | null;
  status: 'invited' | 'active' | 'inactive';
  roles: readonly RoleKey[];
  departmentId: string | null;
  level: AccessLevel;
  jobTitle: string | null;
  /** Whether the user has a membership row in the acting legal entity. */
  inEntity: boolean;
}

export interface SnapshotDepartment {
  id: string;
  name: string;
  headUserId: string | null;
}

export interface AccessSnapshot {
  grants: readonly AccessGrantRow[];
  levelRules: readonly AccessLevelRule[];
  assignment: readonly AccessAssignmentRule[];
  users: readonly SnapshotUser[];
  departments: readonly SnapshotDepartment[];
  /**
   * Open records owned by a user, keyed by `${userId}:${areaKey}` (e.g. open leads/opportunities
   * /draft quotations/open PRs). Used for W7 ("losing work") and member-removal notices.
   */
  openOwnedCounts: ReadonlyMap<string, number>;
}

export interface SimulatedState {
  grants: AccessGrantRow[];
  levelRules: AccessLevelRule[];
  assignment: AccessAssignmentRule[];
  users: SnapshotUser[];
  departments: SnapshotDepartment[];
}

export interface EvaluationResult {
  applied: AccessAppliedChange[];
  impact: AccessImpact;
  warnings: AccessWarning[];
  fieldErrors: Record<string, string>;
  summaries: Record<string, string[]>;
  assignmentSummaries: Record<string, string>;
  before: SimulatedState;
  after: SimulatedState;
}

const grantKey = (role: RoleKey, permission: Permission): string => `${role}:${permission}`;

function plural(n: number, singular: string, pluralWord: string): string {
  return n === 1 ? singular : pluralWord;
}

function levelLabel(level: AccessLevel): string {
  switch (level) {
    case 'staff':
      return 'Staff';
    case 'manager':
      return 'Manager';
    case 'head':
      return 'Head';
  }
}

/**
 * Effective reach for a single user on a permission given grants and level rules (D50, D51, R1).
 * A manager or head only gets department reach from a level switch if one of their roles already
 * has a non-null grant on that area's `seePermission` (review addendum recommendation).
 */
export function effectiveScopeForUser(
  user: Pick<SnapshotUser, 'roles' | 'departmentId' | 'level'>,
  permission: Permission,
  grantMap: ReadonlyMap<string, AccessScope | null>,
  levelMap: ReadonlyMap<AccessSettingAreaKey, AccessLevelRule>,
): { scope: AccessScope | null; viaRole: RoleKey | null; boostedByLevel: boolean } {
  let best: AccessScope | null = null;
  let viaRole: RoleKey | null = null;

  for (const role of user.roles) {
    const scope = grantMap.get(grantKey(role, permission)) ?? null;
    if (reachRank(scope) > reachRank(best)) {
      best = scope;
      viaRole = role;
    }
  }

  let boostedByLevel = false;
  const area = AREA_BY_SEE_PERMISSION.get(permission);
  if (
    area &&
    area.supportsDepartment &&
    best !== null &&
    user.departmentId !== null &&
    reachRank(best) < reachRank('department')
  ) {
    const rule = levelMap.get(area.key);
    if (
      rule &&
      ((user.level === 'head' && rule.headsSeeDepartment) ||
        (user.level === 'manager' && rule.managersSeeDepartment))
    ) {
      best = 'department';
      boostedByLevel = true;
    }
  }

  return { scope: best, viaRole, boostedByLevel };
}

/** Plain-language "Why" lines for Check a person (spec 6.2 AC 3: names at least one role or level). */
export function explainAreaAccess(
  user: Pick<SnapshotUser, 'roles' | 'departmentId' | 'level'>,
  areaKey: AccessSettingAreaKey,
  grantMap: ReadonlyMap<string, AccessScope | null>,
  levelMap: ReadonlyMap<AccessSettingAreaKey, AccessLevelRule>,
): string[] {
  const area = AREA_BY_KEY.get(areaKey);
  if (!area) return [];
  if (user.roles.length === 0) {
    return ['No roles assigned.'];
  }
  if (user.roles.includes('founder')) {
    return ['Founder role gives Everything.'];
  }

  const lines: string[] = [];
  let bestBase: AccessScope | null = null;

  for (const role of user.roles) {
    const scope = grantMap.get(grantKey(role, area.seePermission)) ?? null;
    if (scope !== null) {
      lines.push(`${roleLabel(role)} role gives ${reachLabel(scope, 'record')}.`);
      if (reachRank(scope) > reachRank(bestBase)) bestBase = scope;
    }
  }

  if (lines.length === 0) {
    const roleNames = user.roles.map(roleLabel).join(', ');
    lines.push(`${roleNames} role gives Nothing here.`);
    return lines;
  }

  const rule = levelMap.get(areaKey);
  if (
    area.supportsDepartment &&
    rule &&
    bestBase !== null &&
    reachRank(bestBase) < reachRank('department')
  ) {
    if (user.level === 'head' && rule.headsSeeDepartment) {
      if (user.departmentId !== null) {
        lines.push('Department head level adds Their department.');
      } else {
        lines.push('Department head level requires a department to add Their department.');
      }
    } else if (user.level === 'manager' && rule.managersSeeDepartment) {
      if (user.departmentId !== null) {
        lines.push('Manager level adds Their department.');
      } else {
        lines.push('Manager level requires a department to add Their department.');
      }
    }
  }

  return lines;
}

function cloneState(snapshot: AccessSnapshot): SimulatedState {
  return {
    grants: snapshot.grants.map((g) => ({ ...g })),
    levelRules: snapshot.levelRules.map((l) => ({ ...l, defaults: { ...l.defaults } })),
    assignment: snapshot.assignment.map((a) => ({
      ...a,
      handOvers: a.handOvers.map((h) => ({ ...h })),
      defaults: { ...a.defaults, handOvers: a.defaults.handOvers.map((h) => ({ ...h })) },
    })),
    users: snapshot.users.map((u) => ({ ...u, roles: [...u.roles] })),
    departments: snapshot.departments.map((d) => ({ ...d })),
  };
}

function buildGrantMap(grants: readonly AccessGrantRow[]): Map<string, AccessScope | null> {
  return new Map(grants.map((g) => [grantKey(g.role, g.permission), g.scope]));
}

function buildLevelMap(
  levelRules: readonly AccessLevelRule[],
): Map<AccessSettingAreaKey, AccessLevelRule> {
  return new Map(levelRules.map((l) => [l.area, l]));
}

function setGrantInState(
  state: SimulatedState,
  grantMap: Map<string, AccessScope | null>,
  role: RoleKey,
  permission: Permission,
  scope: AccessScope | null,
): void {
  grantMap.set(grantKey(role, permission), scope);
  const existing = state.grants.find((g) => g.role === role && g.permission === permission);
  const def = defaultScopeFor(role, permission);
  if (existing) {
    existing.scope = scope;
    existing.isDefault = scope === def;
  } else {
    state.grants.push({
      role,
      permission,
      scope,
      defaultScope: def,
      isDefault: scope === def,
    });
  }
}

/**
 * Purely evaluates a batch of proposed changes against `snapshot` without touching the database.
 */
export function evaluateAccessChanges(
  snapshot: AccessSnapshot,
  changes: readonly AccessChange[],
): EvaluationResult {
  const before = cloneState(snapshot);
  const after = cloneState(snapshot);

  const beforeGrants = buildGrantMap(before.grants);
  const afterGrants = buildGrantMap(after.grants);
  const beforeLevels = buildLevelMap(before.levelRules);
  const afterLevels = buildLevelMap(after.levelRules);
  const deptById = new Map(after.departments.map((d) => [d.id, d]));
  const userById = new Map(after.users.map((u) => [u.id, u]));

  const applied: AccessAppliedChange[] = [];
  const warnings: AccessWarning[] = [];
  const fieldErrors: Record<string, string> = {};

  const pushWarning = (w: AccessWarning) => {
    // Avoid duplicate identical warnings for the same code + message.
    if (!warnings.some((existing) => existing.code === w.code && existing.message === w.message)) {
      warnings.push(w);
    }
  };

  for (let i = 0; i < changes.length; i += 1) {
    const change = changes[i]!;

    switch (change.kind) {
      case 'grant': {
        const roleInfo = ROLE_BY_KEY.get(change.role);
        const permInfo = PERMISSION_BY_KEY.get(change.permission);
        if (!roleInfo || !permInfo) {
          fieldErrors[`changes.${i}`] = 'Unknown role or permission.';
          break;
        }
        // W1: Founder role is locked.
        if (change.role === 'founder') {
          const message = 'Founders always have full access.';
          fieldErrors[`changes.${i}.role`] = message;
          pushWarning({ code: 'W1', severity: 'blocked', message, changeIndex: i });
          break;
        }
        // W2: Only Founders can hold admin.roles.write.
        if (change.permission === 'admin.roles.write' && change.scope !== null) {
          const message = 'Only Founders can change access.';
          fieldErrors[`changes.${i}.permission`] = message;
          pushWarning({ code: 'W2', severity: 'blocked', message, changeIndex: i });
          break;
        }
        // W9: Portal boundary (portal permission on staff role, or staff permission on portal role).
        if (
          change.scope !== null &&
          ((roleInfo.kind === 'staff' && permInfo.kind === 'portal') ||
            (roleInfo.kind === 'portal' && permInfo.kind !== 'portal'))
        ) {
          const message =
            roleInfo.kind === 'staff'
              ? 'This is only for portal users.'
              : 'Portal users can only be given portal access.';
          fieldErrors[`changes.${i}.permission`] = message;
          pushWarning({ code: 'W9', severity: 'blocked', message, changeIndex: i });
          break;
        }
        // Scope validity check (valid scopes per role kind and permission).
        if (!isScopeAllowedForRole(change.role, change.permission, change.scope)) {
          fieldErrors[`changes.${i}.scope`] =
            `${reachLabel(change.scope, permInfo.kind)} is not available for ${permInfo.label} on ${roleInfo.label}.`;
          break;
        }

        const prev = afterGrants.get(grantKey(change.role, change.permission)) ?? null;
        if (prev !== change.scope) {
          setGrantInState(after, afterGrants, change.role, change.permission, change.scope);
          applied.push({
            label: `${roleInfo.label} · ${permInfo.label}`,
            from: reachLabel(prev, permInfo.kind),
            to: reachLabel(change.scope, permInfo.kind),
          });
        }
        break;
      }

      case 'resetRole': {
        const roleInfo = ROLE_BY_KEY.get(change.role);
        if (!roleInfo) {
          fieldErrors[`changes.${i}.role`] = 'Unknown role.';
          break;
        }
        if (change.role === 'founder') {
          const message = 'Founders always have full access.';
          fieldErrors[`changes.${i}.role`] = message;
          pushWarning({ code: 'W1', severity: 'blocked', message, changeIndex: i });
          break;
        }

        for (const permInfo of ACCESS_PERMISSION_CATALOGUE) {
          const prev = afterGrants.get(grantKey(change.role, permInfo.key)) ?? null;
          const target = defaultScopeFor(change.role, permInfo.key);
          if (prev !== target) {
            setGrantInState(after, afterGrants, change.role, permInfo.key, target);
            applied.push({
              label: `${roleInfo.label} · ${permInfo.label}`,
              from: reachLabel(prev, permInfo.kind),
              to: reachLabel(target, permInfo.kind),
              serverAdded: true,
            });
          }
        }
        break;
      }

      case 'levelRule': {
        const area = AREA_BY_KEY.get(change.area);
        if (!area) {
          fieldErrors[`changes.${i}.area`] = 'Unknown area.';
          break;
        }
        if (!area.supportsDepartment) {
          fieldErrors[`changes.${i}.area`] = `${area.label} does not use department rules.`;
          break;
        }
        const current = afterLevels.get(change.area);
        if (!current) break;

        if (
          change.managersSeeDepartment !== undefined &&
          change.managersSeeDepartment !== current.managersSeeDepartment
        ) {
          const prevVal = current.managersSeeDepartment;
          current.managersSeeDepartment = change.managersSeeDepartment;
          applied.push({
            label: `${area.label} · Managers see their department`,
            from: prevVal ? 'On' : 'Off',
            to: change.managersSeeDepartment ? 'On' : 'Off',
          });
        }
        if (
          change.headsSeeDepartment !== undefined &&
          change.headsSeeDepartment !== current.headsSeeDepartment
        ) {
          const prevVal = current.headsSeeDepartment;
          current.headsSeeDepartment = change.headsSeeDepartment;
          applied.push({
            label: `${area.label} · Department heads see their department`,
            from: prevVal ? 'On' : 'Off',
            to: change.headsSeeDepartment ? 'On' : 'Off',
          });
        }
        break;
      }

      case 'assignment': {
        const current = after.assignment.find((a) => a.area === change.area);
        if (!current) {
          fieldErrors[`changes.${i}.area`] = 'Assignment rules are not available for this area.';
          break;
        }
        const areaLabel = AREA_BY_KEY.get(change.area)?.label ?? change.area;

        if (change.staff !== undefined && change.staff !== current.staff) {
          const prev = current.staff;
          current.staff = change.staff;
          applied.push({
            label: `${areaLabel} · Staff can assign to`,
            from: staffAssignmentRuleLabel(prev),
            to: staffAssignmentRuleLabel(change.staff),
          });
        }
        if (change.managers !== undefined && change.managers !== current.managers) {
          const prev = current.managers;
          current.managers = change.managers;
          applied.push({
            label: `${areaLabel} · Managers and heads can assign to`,
            from: managerAssignmentRuleLabel(prev),
            to: managerAssignmentRuleLabel(change.managers),
          });
        }
        if (change.handOvers !== undefined) {
          let pairInvalid = false;
          const seenPairs = new Set<string>();
          const nextHandOvers: AccessAssignmentRule['handOvers'] = [];
          for (let p = 0; p < change.handOvers.length; p += 1) {
            const pair = change.handOvers[p]!;
            if (pair.fromDepartmentId === pair.toDepartmentId) {
              fieldErrors[`changes.${i}.handOvers.${p}`] =
                'A hand-over must be between two different departments.';
              pairInvalid = true;
              continue;
            }
            const fromDept = deptById.get(pair.fromDepartmentId);
            const toDept = deptById.get(pair.toDepartmentId);
            if (!fromDept || !toDept) {
              fieldErrors[`changes.${i}.handOvers.${p}`] =
                'Hand-over departments must belong to this company.';
              pairInvalid = true;
              continue;
            }
            const key = `${pair.fromDepartmentId}->${pair.toDepartmentId}`;
            if (seenPairs.has(key)) continue;
            seenPairs.add(key);
            nextHandOvers.push({
              fromDepartmentId: pair.fromDepartmentId,
              toDepartmentId: pair.toDepartmentId,
              fromDepartmentName: fromDept.name,
              toDepartmentName: toDept.name,
            });
          }
          if (!pairInvalid) {
            const formatPairs = (list: AccessAssignmentRule['handOvers']) =>
              list.length === 0
                ? 'None'
                : list
                    .map(
                      (h) =>
                        `${h.fromDepartmentName ?? 'Department'} -> ${h.toDepartmentName ?? 'Department'}`,
                    )
                    .join(', ');
            const prevKey = current.handOvers
              .map((h) => `${h.fromDepartmentId}->${h.toDepartmentId}`)
              .sort()
              .join('|');
            const nextKey = nextHandOvers
              .map((h) => `${h.fromDepartmentId}->${h.toDepartmentId}`)
              .sort()
              .join('|');
            if (prevKey !== nextKey) {
              const fromText = formatPairs(current.handOvers);
              const toText = formatPairs(nextHandOvers);
              current.handOvers = nextHandOvers;
              applied.push({
                label: `${areaLabel} · Department hand-overs`,
                from: fromText,
                to: toText,
              });
            }
          }
        }
        break;
      }

      case 'memberLevel': {
        const dept = deptById.get(change.departmentId);
        const user = userById.get(change.userId);
        if (!dept) {
          fieldErrors[`changes.${i}.departmentId`] = 'Department not found.';
          break;
        }
        if (!user || !user.inEntity) {
          fieldErrors[`changes.${i}.userId`] = 'Person does not belong to this company.';
          break;
        }
        if (user.departmentId !== dept.id) {
          fieldErrors[`changes.${i}.userId`] = `${user.name} is not a member of ${dept.name}.`;
          break;
        }
        if (user.level === change.level) break;
        const prevLevel = user.level;
        user.level = change.level;
        applied.push({
          label: `${user.name} in ${dept.name}`,
          from: levelLabel(prevLevel),
          to: levelLabel(change.level),
        });
        if (change.level === 'head') {
          if (dept.headUserId !== null && dept.headUserId !== user.id) {
            const prevHead = userById.get(dept.headUserId);
            if (prevHead && prevHead.departmentId === dept.id && prevHead.level === 'head') {
              prevHead.level = 'manager';
              applied.push({
                label: `${prevHead.name} in ${dept.name}`,
                from: 'Head',
                to: 'Manager',
                serverAdded: true,
              });
            }
          }
          dept.headUserId = user.id;
        } else if (prevLevel === 'head' && dept.headUserId === user.id) {
          dept.headUserId = null;
        }
        break;
      }

      case 'memberAdd': {
        const dept = deptById.get(change.departmentId);
        const user = userById.get(change.userId);
        if (!dept) {
          fieldErrors[`changes.${i}.departmentId`] = 'Department not found.';
          break;
        }
        if (!user || !user.inEntity) {
          fieldErrors[`changes.${i}.userId`] = 'Person does not belong to this company.';
          break;
        }
        const nextLevel: AccessLevel = change.level ?? 'staff';
        const prevDept = user.departmentId ? deptById.get(user.departmentId) : undefined;
        if (prevDept && prevDept.id !== dept.id && prevDept.headUserId === user.id) {
          prevDept.headUserId = null;
        }
        user.departmentId = dept.id;
        user.level = nextLevel;
        if (change.jobTitle !== undefined) user.jobTitle = change.jobTitle;
        applied.push({
          label: `${user.name} · Department`,
          from: prevDept ? prevDept.name : 'No department',
          to: `${dept.name} (${levelLabel(nextLevel)})`,
        });
        if (nextLevel === 'head') {
          if (dept.headUserId !== null && dept.headUserId !== user.id) {
            const prevHead = userById.get(dept.headUserId);
            if (prevHead && prevHead.departmentId === dept.id && prevHead.level === 'head') {
              prevHead.level = 'manager';
              applied.push({
                label: `${prevHead.name} in ${dept.name}`,
                from: 'Head',
                to: 'Manager',
                serverAdded: true,
              });
            }
          }
          dept.headUserId = user.id;
        }
        break;
      }

      case 'memberRemove': {
        const dept = deptById.get(change.departmentId);
        const user = userById.get(change.userId);
        if (!dept) {
          fieldErrors[`changes.${i}.departmentId`] = 'Department not found.';
          break;
        }
        if (!user || user.departmentId !== dept.id) {
          fieldErrors[`changes.${i}.userId`] = 'Person is not a member of this department.';
          break;
        }
        user.departmentId = null;
        user.level = 'staff';
        if (dept.headUserId === user.id) dept.headUserId = null;
        applied.push({
          label: `${user.name} · Department`,
          from: dept.name,
          to: 'No department',
        });
        break;
      }

      case 'memberMove': {
        const fromDept = deptById.get(change.fromDepartmentId);
        const toDept = deptById.get(change.toDepartmentId);
        const user = userById.get(change.userId);
        if (!fromDept || !toDept) {
          fieldErrors[`changes.${i}`] = 'Department not found.';
          break;
        }
        if (fromDept.id === toDept.id) {
          fieldErrors[`changes.${i}.toDepartmentId`] = 'Choose a different department to move to.';
          break;
        }
        if (!user || user.departmentId !== fromDept.id) {
          fieldErrors[`changes.${i}.userId`] = 'Person is not a member of that department.';
          break;
        }
        if (fromDept.headUserId === user.id) {
          fromDept.headUserId = null;
        }
        // Moving a person starts them as staff in the new department unless promoted separately.
        if (user.level === 'head') {
          user.level = 'staff';
        }
        user.departmentId = toDept.id;
        applied.push({
          label: `${user.name} · Department`,
          from: fromDept.name,
          to: toDept.name,
        });
        break;
      }

      case 'memberJobTitle': {
        const dept = deptById.get(change.departmentId);
        const user = userById.get(change.userId);
        if (!dept) {
          fieldErrors[`changes.${i}.departmentId`] = 'Department not found.';
          break;
        }
        if (!user || user.departmentId !== dept.id) {
          fieldErrors[`changes.${i}.userId`] = 'Person is not a member of this department.';
          break;
        }
        if (user.jobTitle === change.jobTitle) break;
        const prevTitle = user.jobTitle;
        user.jobTitle = change.jobTitle;
        applied.push({
          label: `${user.name} · Job title`,
          from: prevTitle ?? 'None',
          to: change.jobTitle ?? 'None',
        });
        break;
      }

      case 'head': {
        const dept = deptById.get(change.departmentId);
        if (!dept) {
          fieldErrors[`changes.${i}.departmentId`] = 'Department not found.';
          break;
        }
        const prevHead = dept.headUserId ? userById.get(dept.headUserId) : undefined;
        if (change.userId === null) {
          if (dept.headUserId === null) break;
          dept.headUserId = null;
          applied.push({
            label: `${dept.name} · Department head`,
            from: prevHead ? prevHead.name : 'Assigned head',
            to: 'No head',
          });
          if (prevHead && prevHead.departmentId === dept.id && prevHead.level === 'head') {
            prevHead.level = 'manager';
            applied.push({
              label: `${prevHead.name} in ${dept.name}`,
              from: 'Head',
              to: 'Manager',
              serverAdded: true,
            });
          }
          break;
        }
        const nextHead = userById.get(change.userId);
        if (!nextHead || !nextHead.inEntity) {
          fieldErrors[`changes.${i}.userId`] = 'Person does not belong to this company.';
          break;
        }
        if (nextHead.departmentId !== dept.id) {
          fieldErrors[`changes.${i}.userId`] = `${nextHead.name} is not a member of ${dept.name}.`;
          break;
        }
        if (dept.headUserId === nextHead.id) break;

        dept.headUserId = nextHead.id;
        nextHead.level = 'head';
        applied.push({
          label: `${nextHead.name} becomes head of ${dept.name}`,
          from: prevHead ? prevHead.name : 'No head',
          to: nextHead.name,
        });
        if (prevHead && prevHead.id !== nextHead.id && prevHead.departmentId === dept.id) {
          prevHead.level = 'manager';
          applied.push({
            label: `${prevHead.name} becomes a manager in ${dept.name}`,
            from: 'Head',
            to: 'Manager',
            serverAdded: true,
          });
        }
        break;
      }
    }
  }

  // --- Compute warnings W3 through W8 from before vs after ---
  const activeUsersBefore = before.users.filter((u) => u.status === 'active');
  const activeUsersAfter = after.users.filter((u) => u.status === 'active');

  const activeHoldersOfRole = (role: RoleKey): SnapshotUser[] =>
    activeUsersAfter.filter((u) => u.roles.includes(role));

  // W3: Administration permissions newly given to a non-Founder role.
  for (const role of ROLE_BY_KEY.values()) {
    if (role.kind !== 'staff') continue;
    for (const perm of ADMIN_CONFIRM_PERMISSIONS) {
      const prev = beforeGrants.get(grantKey(role.key, perm)) ?? null;
      const next = afterGrants.get(grantKey(role.key, perm)) ?? null;
      if (prev === null && next !== null) {
        const people = activeHoldersOfRole(role.key).length;
        const permLabelLower = permissionLabel(perm).toLowerCase();
        const message =
          people > 0
            ? `${people} ${plural(people, 'person', 'people')} in ${role.label} will be able to ${permLabelLower}.`
            : `${role.label} will be able to ${permLabelLower}.`;
        pushWarning({
          code: 'W3',
          severity: 'confirm',
          message,
          people,
        });
      }
    }
  }

  // W4: Maker and checker — a non-Founder role newly holds both sides of a checked step.
  for (const role of ROLE_BY_KEY.values()) {
    if (role.kind !== 'staff') continue;
    for (const conflict of MAKER_CHECKER_CONFLICTS) {
      const [pA, pB] = conflict.permissions;
      const hadBoth =
        (beforeGrants.get(grantKey(role.key, pA)) ?? null) !== null &&
        (beforeGrants.get(grantKey(role.key, pB)) ?? null) !== null;
      const hasBoth =
        (afterGrants.get(grantKey(role.key, pA)) ?? null) !== null &&
        (afterGrants.get(grantKey(role.key, pB)) ?? null) !== null;
      if (!hadBoth && hasBoth) {
        const people = activeHoldersOfRole(role.key).length;
        pushWarning({
          code: 'W4',
          severity: 'confirm',
          message: `${role.label} could both ${conflict.actionText}. The same person still cannot do both on one ${conflict.noun}.`,
          people,
        });
      }
    }
  }

  // W5: Wide open — a role with active people gains "Everything" on an area or gains cost & margin.
  for (const role of ROLE_BY_KEY.values()) {
    if (role.kind !== 'staff') continue;
    const people = activeHoldersOfRole(role.key).length;
    if (people === 0) continue;

    for (const area of ACCESS_AREA_CATALOGUE) {
      const prev = beforeGrants.get(grantKey(role.key, area.seePermission)) ?? null;
      const next = afterGrants.get(grantKey(role.key, area.seePermission)) ?? null;
      if (prev !== 'all' && next === 'all') {
        pushWarning({
          code: 'W5',
          severity: 'confirm',
          message: `${people} ${plural(people, 'person', 'people')} will see every ${AREA_SINGULAR_NOUN[area.key]}.`,
          people,
        });
      }
    }

    const prevCost = beforeGrants.get(grantKey(role.key, 'quotation.cost.read')) ?? null;
    const nextCost = afterGrants.get(grantKey(role.key, 'quotation.cost.read')) ?? null;
    if (prevCost === null && nextCost !== null) {
      pushWarning({
        code: 'W5',
        severity: 'confirm',
        message: `${people} ${plural(people, 'person', 'people')} will see cost and margin on quotations.`,
        people,
      });
    }
  }

  // W6: Nobody left — (a) no non-Founder role sees an area; (b) a department loses its last head/manager.
  const staffRoles = [...ROLE_BY_KEY.values()].filter((r) => r.kind === 'staff');
  for (const area of ACCESS_AREA_CATALOGUE) {
    const anyBefore = staffRoles.some(
      (r) => (beforeGrants.get(grantKey(r.key, area.seePermission)) ?? null) !== null,
    );
    const anyAfter = staffRoles.some(
      (r) => (afterGrants.get(grantKey(r.key, area.seePermission)) ?? null) !== null,
    );
    if (anyBefore && !anyAfter) {
      pushWarning({
        code: 'W6',
        severity: 'confirm',
        message: `Only Founders will be able to see ${AREA_PLURAL_NOUN[area.key]}.`,
      });
    }
  }

  for (const deptAfter of after.departments) {
    const deptBefore = before.departments.find((d) => d.id === deptAfter.id);
    if (!deptBefore) continue;
    const hadLeadBefore =
      deptBefore.headUserId !== null ||
      before.users.some(
        (u) =>
          u.status === 'active' &&
          u.departmentId === deptBefore.id &&
          (u.level === 'head' || u.level === 'manager'),
      );
    const hasLeadAfter =
      deptAfter.headUserId !== null ||
      after.users.some(
        (u) =>
          u.status === 'active' &&
          u.departmentId === deptAfter.id &&
          (u.level === 'head' || u.level === 'manager'),
      );
    if (hadLeadBefore && !hasLeadAfter) {
      pushWarning({
        code: 'W6',
        severity: 'confirm',
        message: `No one will see all of ${deptAfter.name}'s work except people who see everything.`,
      });
    }
  }

  // W7: Losing work — active people whose reach narrowed below 'own' (cannot open records they own)
  // while owning open records in that area.
  for (const area of ACCESS_AREA_CATALOGUE) {
    let affectedPeople = 0;
    let affectedRecords = 0;
    for (const userBefore of activeUsersBefore) {
      if (userBefore.roles.includes('founder')) continue;
      const userAfter = after.users.find((u) => u.id === userBefore.id);
      if (!userAfter) continue;

      const prevSee = effectiveScopeForUser(
        userBefore,
        area.seePermission,
        beforeGrants,
        beforeLevels,
      ).scope;
      const nextSee = effectiveScopeForUser(
        userAfter,
        area.seePermission,
        afterGrants,
        afterLevels,
      ).scope;

      const ownedOpen = snapshot.openOwnedCounts.get(`${userBefore.id}:${area.key}`) ?? 0;
      if (ownedOpen <= 0) continue;

      // Narrowed so they can no longer open their own records (e.g. own/department/all -> null or assigned).
      const lostSeeOwn = reachRank(prevSee) >= reachRank('own') && reachRank(nextSee) < reachRank('own');
      // Or lost write access on their own records in leads/opportunities/quotations.
      const primaryAction = area.actionPermissions[0];
      const lostWriteOwn =
        primaryAction !== undefined &&
        reachRank(
          effectiveScopeForUser(userBefore, primaryAction, beforeGrants, beforeLevels).scope,
        ) >= reachRank('own') &&
        reachRank(
          effectiveScopeForUser(userAfter, primaryAction, afterGrants, afterLevels).scope,
        ) < reachRank('own');

      if (lostSeeOwn || lostWriteOwn) {
        affectedPeople += 1;
        affectedRecords += ownedOpen;
      }
    }
    if (affectedPeople > 0 && affectedRecords > 0) {
      pushWarning({
        code: 'W7',
        severity: 'confirm',
        message: `${affectedPeople} ${plural(affectedPeople, 'person', 'people')} will no longer be able to open ${affectedRecords} ${AREA_PLURAL_NOUN[area.key]} they are working on.`,
        people: affectedPeople,
        records: affectedRecords,
      });
    }
  }

  // W8: Does more than sees (info) — after the change, a non-Founder role has an area action whose
  // reach is wider than its see reach on that same area, and this change touched either permission.
  for (const role of staffRoles) {
    for (const area of ACCESS_AREA_CATALOGUE) {
      const seeBefore = beforeGrants.get(grantKey(role.key, area.seePermission)) ?? null;
      const seeAfter = afterGrants.get(grantKey(role.key, area.seePermission)) ?? null;

      for (const actionPerm of area.actionPermissions) {
        const permInfo = PERMISSION_BY_KEY.get(actionPerm);
        if (!permInfo || permInfo.kind !== 'record') continue;
        const actBefore = beforeGrants.get(grantKey(role.key, actionPerm)) ?? null;
        const actAfter = afterGrants.get(grantKey(role.key, actionPerm)) ?? null;
        if (seeBefore === seeAfter && actBefore === actAfter) continue;
        if (actAfter !== null && reachRank(actAfter) > reachRank(seeAfter)) {
          const actionText = permInfo.label.toLowerCase();
          const message =
            seeAfter === null
              ? `${role.label} can still ${actionText} (${reachLabel(actAfter, 'record').toLowerCase()}) but cannot see ${AREA_PLURAL_NOUN[area.key]}. Change that under By role if it is not what you want.`
              : `${role.label} can still ${actionText} (${reachLabel(actAfter, 'record').toLowerCase()}) but will only see ${reachLabel(seeAfter, 'record').toLowerCase()}. Change that under By role if it is not what you want.`;
          pushWarning({ code: 'W8', severity: 'info', message });
        }
      }
    }
  }

  // --- Impact counts across active users ---
  const widenedNames: string[] = [];
  const narrowedNames: string[] = [];
  let unchanged = 0;

  // Determine which permissions or areas could have changed for active staff/portal users.
  const pairSetKey = (list: AccessAssignmentRule['handOvers']) =>
    list
      .map((h) => `${h.fromDepartmentId}->${h.toDepartmentId}`)
      .sort()
      .join('|');
  const assignmentChangedAreas = new Set<AssignmentAreaKey>();
  for (const afterRule of after.assignment) {
    const beforeRule = before.assignment.find((a) => a.area === afterRule.area);
    if (
      !beforeRule ||
      beforeRule.staff !== afterRule.staff ||
      beforeRule.managers !== afterRule.managers ||
      pairSetKey(beforeRule.handOvers) !== pairSetKey(afterRule.handOvers)
    ) {
      assignmentChangedAreas.add(afterRule.area);
    }
  }

  for (const userBefore of activeUsersBefore) {
    const userAfter = after.users.find((u) => u.id === userBefore.id);
    if (!userAfter) continue;

    let userWidened = false;
    let userNarrowed = false;

    for (const perm of ACCESS_PERMISSION_CATALOGUE) {
      const prevRank = reachRank(
        effectiveScopeForUser(userBefore, perm.key, beforeGrants, beforeLevels).scope,
      );
      const nextRank = reachRank(
        effectiveScopeForUser(userAfter, perm.key, afterGrants, afterLevels).scope,
      );
      if (nextRank > prevRank) userWidened = true;
      if (nextRank < prevRank) userNarrowed = true;
    }

    // Also count department-level changes that affect assignment reach when assignment config changed.
    if (!userWidened && !userNarrowed && assignmentChangedAreas.size > 0 && !userBefore.roles.includes('founder')) {
      for (const areaKey of assignmentChangedAreas) {
        const bRule = before.assignment.find((a) => a.area === areaKey);
        const aRule = after.assignment.find((a) => a.area === areaKey);
        if (!bRule || !aRule) continue;
        if (userAfter.level === 'staff' && bRule.staff !== aRule.staff) {
          if (aRule.staff === 'self_only') userNarrowed = true;
          else if (bRule.staff === 'self_only') userWidened = true;
        }
        if (userAfter.level === 'manager' && bRule.managers !== aRule.managers) {
          if (aRule.managers === 'self_and_staff') userNarrowed = true;
          else userWidened = true;
        }
        if (userAfter.departmentId !== null) {
          const hadFrom = bRule.handOvers.filter((h) => h.fromDepartmentId === userAfter.departmentId).length;
          const hasFrom = aRule.handOvers.filter((h) => h.fromDepartmentId === userAfter.departmentId).length;
          if (hasFrom > hadFrom) userWidened = true;
          if (hasFrom < hadFrom) userNarrowed = true;
        }
      }
    }

    if (userWidened) widenedNames.push(userAfter.name);
    if (userNarrowed) narrowedNames.push(userAfter.name);
    if (!userWidened && !userNarrowed) unchanged += 1;
  }

  const impact: AccessImpact = {
    widened: {
      people: widenedNames.length,
      sample: widenedNames.slice(0, 3),
      names: widenedNames,
    },
    narrowed: {
      people: narrowedNames.length,
      sample: narrowedNames.slice(0, 3),
      names: narrowedNames,
    },
    unchanged,
  };

  return {
    applied,
    impact,
    warnings,
    fieldErrors,
    summaries: buildAreaSummaries(after.grants, after.levelRules),
    assignmentSummaries: buildAssignmentSummaries(after.assignment),
    before,
    after,
  };
}
