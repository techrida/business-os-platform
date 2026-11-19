// Access Settings service (U20b): catalogue read, dry-run preview, atomic save with optimistic
// locking, server-side re-validation of warnings W1-W9, transactional audit trail, cache
// invalidation, and live Check a person report.
import {
  ACCESS_SETTING_AREA_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  ROLE_KEYS,
  type AccessCatalogueResponse,
  type AccessChange,
  type AccessGrantRow,
  type AccessLevel,
  type AccessLevelRule,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  type AccessSaveRequest,
  type AccessScope,
  type AccessSettingAreaKey,
  type AssignmentAreaKey,
  type AssignmentParty,
  type CheckPersonAction,
  type CheckPersonAreaRow,
  type CheckPersonAssignable,
  type CheckPersonReport,
  type Permission,
  type RoleKey,
} from '@bos/contracts';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { type Actor, type TxScope, withTx } from '../../platform/db/tx';
import { assignableTargets } from '../leads/lead-assignment-rule';
import {
  ACCESS_AREA_CATALOGUE,
  ACCESS_CONFLICTS,
  ACCESS_PERMISSION_CATALOGUE,
  ACCESS_PERMISSION_GROUPS,
  ACCESS_ROLE_CATALOGUE,
  AREA_BY_KEY,
  DEFAULT_LEVEL_RULES,
  LEVEL_AREA_BY_PERMISSION,
  PERMISSION_BY_KEY,
  defaultScopeFor,
  impliedLevelRows,
  levelRulePermissions,
  permissionLabel,
  reachLabel,
  roleLabel,
} from './access-catalogue';
import {
  type AccessSnapshot,
  type SimulatedState,
  type SnapshotDepartment,
  type SnapshotUser,
  effectiveScopeForUser,
  evaluateAccessChanges,
  explainAreaAccess,
} from './access-evaluator';
import {
  type AccessQueryable,
  type AccessRevisionRow,
  bumpAccessRevision,
  lockAccessRevision,
  readAccessRevision,
} from './access-revision';
import { buildAreaSummaries, buildAssignmentSummaries } from './access-summaries';
import { loadAssignmentConfig, toAssignmentRuleConfig } from './assignment-config';

const ROLE_KEY_SET: ReadonlySet<string> = new Set(ROLE_KEYS);

type RolePermissionDbRow = {
  roleKey: string;
  permission: string;
  scope: AccessScope;
  seeded: boolean;
};

type RolePermissionLevelDbRow = {
  roleKey: string;
  permission: string;
  minLevel: 'manager' | 'head';
  scope: AccessScope;
  seeded: boolean;
};

type UserDbRow = {
  id: string;
  name: string;
  email: string | null;
  status: 'invited' | 'active' | 'inactive';
  inEntity: boolean;
  departmentId: string | null;
  level: AccessLevel;
  jobTitle: string | null;
  entityRoleKeys: string[] | null;
  partyId: string | null;
};

type UserRoleDbRow = {
  userId: string;
  roleKey: string;
};

type DeptDbRow = {
  id: string;
  name: string;
  headUserId: string | null;
};

type CountDbRow = {
  count: string;
};

type UserCountDbRow = {
  userId: string;
  count: string;
};

interface LoadedSnapshot {
  revisionRow: AccessRevisionRow;
  hasPersistedGrants: boolean;
  hasPersistedLevelRows: boolean;
  snapshot: AccessSnapshot;
  /** Party ID per user (non-null only for portal users via app.idp_orgs). */
  partyByUserId: Map<string, string | null>;
}

const grantKey = (role: RoleKey, permission: Permission): string => `${role}:${permission}`;

function deriveLevelRules(
  levelRulesMaterialized: boolean,
  rplRows: readonly RolePermissionLevelDbRow[],
): AccessLevelRule[] {
  const useDefaults = !levelRulesMaterialized && rplRows.length === 0;
  return ACCESS_AREA_CATALOGUE.map((area) => {
    const def = DEFAULT_LEVEL_RULES[area.key];
    if (!area.supportsDepartment) {
      return {
        area: area.key,
        managersSeeDepartment: false,
        headsSeeDepartment: false,
        defaults: { ...def },
      };
    }
    if (useDefaults) {
      return {
        area: area.key,
        managersSeeDepartment: def.managersSeeDepartment,
        headsSeeDepartment: def.headsSeeDepartment,
        defaults: { ...def },
      };
    }
    // A switch is on while any of its rows exists, on the see or the paired edit permission: a
    // tenant where no role qualifies for a see row can still hold edit rows, which apply at run
    // time.
    const permissions: readonly string[] = levelRulePermissions(area.key);
    const switchOn = (minLevel: 'manager' | 'head'): boolean =>
      rplRows.some(
        (r) =>
          permissions.includes(r.permission) && r.minLevel === minLevel && r.scope === 'department',
      );
    const managersSeeDepartment = switchOn('manager');
    const headsSeeDepartment = switchOn('head');
    return {
      area: area.key,
      managersSeeDepartment,
      headsSeeDepartment,
      defaults: { ...def },
    };
  });
}

function buildGrantRows(
  hasPersistedGrants: boolean,
  rpRows: readonly RolePermissionDbRow[],
): AccessGrantRow[] {
  const persisted = new Map<string, AccessScope>();
  for (const row of rpRows) {
    persisted.set(`${row.roleKey}:${row.permission}`, row.scope);
  }

  const grants: AccessGrantRow[] = [];
  for (const role of ACCESS_ROLE_CATALOGUE) {
    for (const perm of ACCESS_PERMISSION_CATALOGUE) {
      const def = defaultScopeFor(role.key, perm.key);
      const scope = hasPersistedGrants
        ? (persisted.get(grantKey(role.key, perm.key)) ?? null)
        : def;
      grants.push({
        role: role.key,
        permission: perm.key,
        scope,
        defaultScope: def,
        isDefault: scope === def,
      });
    }
  }
  return grants;
}

@Injectable()
export class AccessSettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `GET /v1/admin/access`: full catalogue, live rules, defaults, active people counts, and
   * plain-language summaries. Read-only and never audited.
   */
  async getCatalogue(scope: TxScope): Promise<AccessCatalogueResponse> {
    const loaded = await this.loadSnapshot(this.db, scope, { includeOpenOwned: false });
    return this.buildCatalogueResponse(loaded);
  }

  /**
   * `POST /v1/admin/access/preview`: dry-run evaluator against live state. Never writes and never
   * audited. When `req.person` is supplied, also returns the simulated Check a person report with
   * `previousScopeLabel` on changed areas.
   */
  async preview(scope: TxScope, req: AccessPreviewRequest): Promise<AccessPreviewResponse> {
    const loaded = await this.loadSnapshot(this.db, scope, { includeOpenOwned: true });
    const evalResult = evaluateAccessChanges(loaded.snapshot, req.changes);

    let report: CheckPersonReport | null | undefined;
    if (req.person !== undefined) {
      const beforeUser = evalResult.before.users.find((u) => u.id === req.person);
      const afterUser = evalResult.after.users.find((u) => u.id === req.person);
      if (afterUser === undefined) {
        report = null;
      } else {
        const beforeGrantMap = new Map(
          evalResult.before.grants.map((g) => [grantKey(g.role, g.permission), g.scope]),
        );
        const beforeLevelMap = new Map(evalResult.before.levelRules.map((l) => [l.area, l]));
        report = await this.buildPersonReport(
          this.db,
          scope,
          afterUser,
          loaded.partyByUserId.get(afterUser.id) ?? null,
          evalResult.after,
          beforeUser
            ? { user: beforeUser, grantMap: beforeGrantMap, levelMap: beforeLevelMap }
            : undefined,
        );
      }
    }

    return {
      applied: evalResult.applied,
      impact: evalResult.impact,
      warnings: evalResult.warnings,
      summaries: evalResult.summaries,
      assignmentSummaries: evalResult.assignmentSummaries,
      ...(report === undefined ? {} : { report }),
    };
  }

  /**
   * `GET /v1/admin/access/check?person=<uuid>`: live Check a person report with real visible and
   * total record counts, available actions, assignable colleagues, and plain-language explanations.
   * Read-only and never audited.
   */
  async checkPerson(scope: TxScope, personId: string): Promise<CheckPersonReport> {
    const loaded = await this.loadSnapshot(this.db, scope, { includeOpenOwned: false });
    const user = loaded.snapshot.users.find((u) => u.id === personId);
    if (!user) {
      throw new NotFoundException('Person not found.');
    }
    const liveState: SimulatedState = {
      grants: [...loaded.snapshot.grants],
      levelRules: [...loaded.snapshot.levelRules],
      assignment: [...loaded.snapshot.assignment],
      users: [...loaded.snapshot.users],
      departments: [...loaded.snapshot.departments],
    };
    return this.buildPersonReport(
      this.db,
      scope,
      user,
      loaded.partyByUserId.get(user.id) ?? null,
      liveState,
    );
  }

  /**
   * `POST /v1/admin/access`: validates and commits a batch of access/department changes atomically
   * inside one `withTx` transaction, writes one audit event per applied change, bumps the access
   * revision, and invalidates `AuthzService` immediately after commit.
   */
  async save(
    scope: TxScope,
    actor: Actor,
    req: AccessSaveRequest,
  ): Promise<AccessCatalogueResponse> {
    await withTx(this.db, scope, actor, async (tx) => {
      await lockAccessRevision(tx, scope.tenantId);

      const loaded = await this.loadSnapshot(tx, scope, { includeOpenOwned: true });
      if (loaded.revisionRow.revision !== req.expectedRevision) {
        throw new ConflictException({
          code: 'stale_access',
          message: 'Access settings were changed by someone else. Reload and try again.',
        });
      }

      const evalResult = evaluateAccessChanges(loaded.snapshot, req.changes);
      const blockedWarnings = evalResult.warnings.filter((w) => w.severity === 'blocked');
      const hasFieldErrors = Object.keys(evalResult.fieldErrors).length > 0;
      if (hasFieldErrors || blockedWarnings.length > 0) {
        const firstMessage =
          blockedWarnings[0]?.message ??
          Object.values(evalResult.fieldErrors)[0] ??
          'These access changes cannot be saved.';
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: firstMessage,
          ...(hasFieldErrors ? { fieldErrors: evalResult.fieldErrors } : {}),
          ...(blockedWarnings.length > 0 ? { warnings: blockedWarnings } : {}),
        });
      }

      const acknowledgedSet = new Set(req.acknowledged);
      const unacknowledged = evalResult.warnings.filter(
        (w) => w.severity === 'confirm' && !acknowledgedSet.has(w.code),
      );
      if (unacknowledged.length > 0) {
        throw new ConflictException({
          code: 'confirmation_required',
          message: 'Confirm the warning before saving these access changes.',
          warnings: unacknowledged,
        });
      }

      const hasGrantOrReset = req.changes.some((c) => c.kind === 'grant' || c.kind === 'resetRole');
      const hasLevelRuleChange = req.changes.some((c) => c.kind === 'levelRule');

      // Any save invalidates the role cache, which writes the version row, and a version row with no grant rows reads
      // as a deliberately empty policy: so a tenant still on the code defaults is materialised on every save.
      if (!loaded.hasPersistedGrants) {
        await this.materializeDefaultGrants(tx, scope.tenantId);
      }

      // A tenant on the code default level rows gets them written out before its first level-rule
      // or grant change. A grant change counts too: the role cache applies the code defaults as
      // computed from the default grants, so a role a grant makes newly eligible would get no row
      // there while Check a person showed it the department.
      let levelRulesActive =
        loaded.revisionRow.levelRulesMaterialized || loaded.hasPersistedLevelRows;
      if ((hasLevelRuleChange || hasGrantOrReset) && !levelRulesActive) {
        await this.materializeDefaultLevelRules(tx, scope.tenantId, evalResult.before.grants);
        levelRulesActive = true;
      }

      const auditMeta: Record<string, unknown> = {
        ...(req.note !== undefined && req.note !== '' ? { note: req.note } : {}),
        ...(req.acknowledged.length > 0 ? { acknowledged: req.acknowledged } : {}),
      };

      await this.applyChangesAndAudit(
        tx,
        scope,
        req.changes,
        evalResult.before,
        evalResult.after,
        levelRulesActive,
        auditMeta,
      );

      // Once the rows are the tenant's truth, mark it so, including for rows migration 0088 wrote
      // without the flag: otherwise switching every rule off leaves zero rows and the role cache
      // falls back to the code defaults (the flag only ever turns on).
      await bumpAccessRevision(tx, scope, {
        actorUserId: actor.kind === 'user' ? actor.id : null,
        markLevelRulesMaterialized: levelRulesActive,
      });
    });

    // Invalidate AFTER commit so no request can refill the role cache with pre-commit rows.
    await this.authz.invalidate(scope.tenantId, scope.organizationId);
    return this.getCatalogue(scope);
  }

  // ---------------------------------------------------------------------------
  // Private: persistence helpers
  // ---------------------------------------------------------------------------

  private async materializeDefaultGrants(tx: DbTransaction, tenantId: string): Promise<void> {
    for (const role of ROLE_KEYS) {
      const defaults = DEFAULT_ROLE_PERMISSIONS[role];
      for (const [permission, scope] of Object.entries(defaults)) {
        if (scope === undefined) continue;
        await tx.execute(sql`
          INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
          VALUES (${tenantId}, ${role}, ${permission}, ${scope}, true)
          ON CONFLICT (tenant_id, role_key, permission) DO NOTHING
        `);
      }
    }
  }

  /**
   * Writes the default switches out as rows, computed from the tenant's grants before this save.
   * Seeded, and an existing row is kept.
   */
  private async materializeDefaultLevelRules(
    tx: DbTransaction,
    tenantId: string,
    grantsBefore: readonly AccessGrantRow[],
  ): Promise<void> {
    const grantMap = new Map(grantsBefore.map((g) => [grantKey(g.role, g.permission), g.scope]));
    const defaults = ACCESS_AREA_CATALOGUE.map((area) => ({
      area: area.key,
      ...DEFAULT_LEVEL_RULES[area.key],
    }));
    for (const row of impliedLevelRows(grantMap, defaults)) {
      await tx.execute(sql`
        INSERT INTO app.role_permission_levels (
          tenant_id, role_key, permission, min_level, scope, seeded
        )
        VALUES (${tenantId}, ${row.role}, ${row.permission}, ${row.minLevel}, 'department', true)
        ON CONFLICT (tenant_id, role_key, permission, min_level) DO NOTHING
      `);
    }
  }

  /**
   * Rewrites one area's rows, on its see permission and its paired edit permission together,
   * from its switches and the grants after this save. Turning a switch off therefore also takes
   * the write reach it gave, so a manager cannot edit by id what they can no longer list.
   */
  private async reconcileLevelRulesForArea(
    tx: DbTransaction,
    tenantId: string,
    areaKey: AccessSettingAreaKey,
    afterRule: AccessLevelRule,
    afterGrantMap: ReadonlyMap<string, AccessScope | null>,
  ): Promise<void> {
    const permissions = levelRulePermissions(areaKey);
    if (permissions.length === 0) return;

    for (const permission of permissions) {
      await tx.execute(sql`
        DELETE FROM app.role_permission_levels
         WHERE tenant_id = ${tenantId}
           AND permission = ${permission}
      `);
    }

    const def = DEFAULT_LEVEL_RULES[areaKey];
    const seededAt = {
      manager: afterRule.managersSeeDepartment === def.managersSeeDepartment,
      head: afterRule.headsSeeDepartment === def.headsSeeDepartment,
    };
    for (const row of impliedLevelRows(afterGrantMap, [afterRule])) {
      await tx.execute(sql`
        INSERT INTO app.role_permission_levels (
          tenant_id, role_key, permission, min_level, scope, seeded
        )
        VALUES (
          ${tenantId}, ${row.role}, ${row.permission}, ${row.minLevel}, 'department',
          ${seededAt[row.minLevel]}
        )
        ON CONFLICT (tenant_id, role_key, permission, min_level) DO UPDATE
          SET scope = EXCLUDED.scope, seeded = EXCLUDED.seeded
      `);
    }
  }

  private async applyChangesAndAudit(
    tx: DbTransaction,
    scope: TxScope,
    changes: readonly AccessChange[],
    before: SimulatedState,
    after: SimulatedState,
    levelRulesActive: boolean,
    auditMeta: Record<string, unknown>,
  ): Promise<void> {
    const runningGrants = new Map(
      before.grants.map((g) => [grantKey(g.role, g.permission), g.scope]),
    );
    const runningLevels = new Map(
      before.levelRules.map((l) => [l.area, { ...l, defaults: { ...l.defaults } }]),
    );
    const runningAssignment = new Map(
      before.assignment.map((a) => [
        a.area,
        { ...a, handOvers: a.handOvers.map((h) => ({ ...h })) },
      ]),
    );
    const runningUsers = new Map(before.users.map((u) => [u.id, { ...u, roles: [...u.roles] }]));
    const runningDepts = new Map(before.departments.map((d) => [d.id, { ...d }]));

    const levelAreasToReconcile = new Set<AccessSettingAreaKey>();
    const assignmentAreasToPersist = new Set<AssignmentAreaKey>();

    for (const change of changes) {
      switch (change.kind) {
        case 'grant': {
          const prevScope = runningGrants.get(grantKey(change.role, change.permission)) ?? null;
          if (prevScope === change.scope) break;

          if (change.scope === null) {
            await tx.execute(sql`
              DELETE FROM app.role_permissions
               WHERE tenant_id = ${scope.tenantId}
                 AND role_key = ${change.role}
                 AND permission = ${change.permission}
            `);
          } else {
            await tx.execute(sql`
              INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
              VALUES (${scope.tenantId}, ${change.role}, ${change.permission}, ${change.scope}, false)
              ON CONFLICT (tenant_id, role_key, permission) DO UPDATE
                SET scope = EXCLUDED.scope, seeded = false
            `);
          }

          runningGrants.set(grantKey(change.role, change.permission), change.scope);
          const def = defaultScopeFor(change.role, change.permission);
          await this.audit.record(tx, {
            action: 'access.grant.changed',
            entityType: 'role_permission',
            entityId: `${change.role}:${change.permission}`,
            before: {
              role: change.role,
              permission: change.permission,
              scope: prevScope,
              isDefault: prevScope === def,
            },
            after: {
              role: change.role,
              permission: change.permission,
              scope: change.scope,
              isDefault: change.scope === def,
            },
            meta: auditMeta,
          });

          // The see or the paired edit permission: either changes which roles the switch widens.
          if (levelRulesActive) {
            const levelArea = LEVEL_AREA_BY_PERMISSION.get(change.permission);
            if (levelArea !== undefined) levelAreasToReconcile.add(levelArea.area);
          }
          break;
        }

        case 'resetRole': {
          const changedGrants: {
            permission: Permission;
            before: AccessScope | null;
            after: AccessScope | null;
          }[] = [];

          for (const permInfo of ACCESS_PERMISSION_CATALOGUE) {
            const prevScope = runningGrants.get(grantKey(change.role, permInfo.key)) ?? null;
            const target = defaultScopeFor(change.role, permInfo.key);
            if (prevScope !== target) {
              changedGrants.push({ permission: permInfo.key, before: prevScope, after: target });
              runningGrants.set(grantKey(change.role, permInfo.key), target);
            }
          }

          // Re-materialize this role's rows with seeded = true so isDefault / seeded stay in step.
          await tx.execute(sql`
            DELETE FROM app.role_permissions
             WHERE tenant_id = ${scope.tenantId}
               AND role_key = ${change.role}
          `);
          const defaults = DEFAULT_ROLE_PERMISSIONS[change.role];
          for (const [permission, defaultScope] of Object.entries(defaults)) {
            if (defaultScope === undefined) continue;
            await tx.execute(sql`
              INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
              VALUES (${scope.tenantId}, ${change.role}, ${permission}, ${defaultScope}, true)
            `);
          }

          if (changedGrants.length > 0) {
            await this.audit.record(tx, {
              action: 'access.role.reset',
              entityType: 'role_permission',
              entityId: change.role,
              before: {
                role: change.role,
                changedGrants: changedGrants.map((c) => ({
                  permission: c.permission,
                  scope: c.before,
                })),
              },
              after: {
                role: change.role,
                changedGrants: changedGrants.map((c) => ({
                  permission: c.permission,
                  scope: c.after,
                })),
              },
              meta: auditMeta,
            });

            if (levelRulesActive) {
              for (const area of ACCESS_AREA_CATALOGUE) {
                if (area.supportsDepartment) levelAreasToReconcile.add(area.key);
              }
            }
          }
          break;
        }

        case 'levelRule': {
          const current = runningLevels.get(change.area);
          if (!current) break;
          const prevManagers = current.managersSeeDepartment;
          const prevHeads = current.headsSeeDepartment;
          const nextManagers = change.managersSeeDepartment ?? prevManagers;
          const nextHeads = change.headsSeeDepartment ?? prevHeads;
          if (prevManagers === nextManagers && prevHeads === nextHeads) break;

          current.managersSeeDepartment = nextManagers;
          current.headsSeeDepartment = nextHeads;
          levelAreasToReconcile.add(change.area);

          await this.audit.record(tx, {
            action: 'access.level_rule.changed',
            entityType: 'access_level_rule',
            entityId: change.area,
            before: {
              area: change.area,
              managersSeeDepartment: prevManagers,
              headsSeeDepartment: prevHeads,
            },
            after: {
              area: change.area,
              managersSeeDepartment: nextManagers,
              headsSeeDepartment: nextHeads,
            },
            meta: auditMeta,
          });
          break;
        }

        case 'assignment': {
          const current = runningAssignment.get(change.area);
          if (!current) break;
          const prevSnapshot = {
            area: change.area,
            staff: current.staff,
            managers: current.managers,
            handOvers: current.handOvers.map((h) => ({
              fromDepartmentId: h.fromDepartmentId,
              fromDepartmentName: h.fromDepartmentName ?? null,
              toDepartmentId: h.toDepartmentId,
              toDepartmentName: h.toDepartmentName ?? null,
            })),
          };

          const nextStaff = change.staff ?? current.staff;
          const nextManagers = change.managers ?? current.managers;
          const nextHandOvers =
            change.handOvers !== undefined
              ? change.handOvers.map((pair) => {
                  const fromDept = runningDepts.get(pair.fromDepartmentId);
                  const toDept = runningDepts.get(pair.toDepartmentId);
                  return {
                    fromDepartmentId: pair.fromDepartmentId,
                    toDepartmentId: pair.toDepartmentId,
                    ...(fromDept === undefined ? {} : { fromDepartmentName: fromDept.name }),
                    ...(toDept === undefined ? {} : { toDepartmentName: toDept.name }),
                  };
                })
              : current.handOvers;

          current.staff = nextStaff;
          current.managers = nextManagers;
          current.handOvers = nextHandOvers;
          assignmentAreasToPersist.add(change.area);

          const nextSnapshot = {
            area: change.area,
            staff: nextStaff,
            managers: nextManagers,
            handOvers: nextHandOvers.map((h) => ({
              fromDepartmentId: h.fromDepartmentId,
              fromDepartmentName: h.fromDepartmentName ?? null,
              toDepartmentId: h.toDepartmentId,
              toDepartmentName: h.toDepartmentName ?? null,
            })),
          };

          await this.audit.record(tx, {
            action: 'access.assignment_rule.changed',
            entityType: 'access_assignment_rule',
            entityId: change.area,
            before: prevSnapshot,
            after: nextSnapshot,
            meta: auditMeta,
          });
          break;
        }

        case 'memberLevel': {
          const user = runningUsers.get(change.userId);
          const dept = runningDepts.get(change.departmentId);
          if (!user || !dept || user.level === change.level) break;
          const prevLevel = user.level;

          await tx.execute(sql`
            UPDATE app.user_entities
               SET level = ${change.level}
             WHERE tenant_id = ${scope.tenantId}
               AND organization_id = ${scope.organizationId}
               AND user_id = ${change.userId}
               AND department_id = ${change.departmentId}
          `);

          user.level = change.level;
          if (change.level === 'head') {
            if (dept.headUserId !== null && dept.headUserId !== user.id) {
              const prevHead = runningUsers.get(dept.headUserId);
              if (prevHead && prevHead.departmentId === dept.id && prevHead.level === 'head') {
                prevHead.level = 'manager';
              }
            }
            dept.headUserId = user.id;
          } else if (prevLevel === 'head' && dept.headUserId === user.id) {
            dept.headUserId = null;
          }

          await this.audit.record(tx, {
            action: 'department.member.level_changed',
            entityType: 'user_entity',
            entityId: change.userId,
            before: {
              userId: change.userId,
              departmentId: dept.id,
              departmentName: dept.name,
              level: prevLevel,
            },
            after: {
              userId: change.userId,
              departmentId: dept.id,
              departmentName: dept.name,
              level: change.level,
            },
            meta: auditMeta,
          });
          break;
        }

        case 'memberAdd': {
          const user = runningUsers.get(change.userId);
          const dept = runningDepts.get(change.departmentId);
          if (!user || !dept) break;
          const prevDeptId = user.departmentId;
          const prevLevel = user.level;
          const prevJobTitle = user.jobTitle;
          const nextLevel: AccessLevel = change.level ?? 'staff';
          const nextJobTitle = change.jobTitle !== undefined ? change.jobTitle : user.jobTitle;

          if (change.jobTitle !== undefined) {
            await tx.execute(sql`
              UPDATE app.user_entities
                 SET department_id = ${change.departmentId},
                     level = ${nextLevel},
                     job_title = ${change.jobTitle}
               WHERE tenant_id = ${scope.tenantId}
                 AND organization_id = ${scope.organizationId}
                 AND user_id = ${change.userId}
            `);
          } else {
            await tx.execute(sql`
              UPDATE app.user_entities
                 SET department_id = ${change.departmentId},
                     level = ${nextLevel}
               WHERE tenant_id = ${scope.tenantId}
                 AND organization_id = ${scope.organizationId}
                 AND user_id = ${change.userId}
            `);
          }

          if (prevDeptId && prevDeptId !== dept.id) {
            const oldDept = runningDepts.get(prevDeptId);
            if (oldDept && oldDept.headUserId === user.id) oldDept.headUserId = null;
          }
          user.departmentId = dept.id;
          user.level = nextLevel;
          user.jobTitle = nextJobTitle;
          if (nextLevel === 'head') {
            if (dept.headUserId !== null && dept.headUserId !== user.id) {
              const prevHead = runningUsers.get(dept.headUserId);
              if (prevHead && prevHead.departmentId === dept.id && prevHead.level === 'head') {
                prevHead.level = 'manager';
              }
            }
            dept.headUserId = user.id;
          }

          await this.audit.record(tx, {
            action: 'department.member.added',
            entityType: 'user_entity',
            entityId: change.userId,
            before: {
              userId: change.userId,
              departmentId: prevDeptId,
              level: prevLevel,
              jobTitle: prevJobTitle,
            },
            after: {
              userId: change.userId,
              departmentId: dept.id,
              departmentName: dept.name,
              level: nextLevel,
              jobTitle: nextJobTitle,
            },
            meta: auditMeta,
          });
          break;
        }

        case 'memberRemove': {
          const user = runningUsers.get(change.userId);
          const dept = runningDepts.get(change.departmentId);
          if (!user || !dept) break;
          const prevLevel = user.level;

          await tx.execute(sql`
            UPDATE app.user_entities
               SET department_id = NULL,
                   level = 'staff'
             WHERE tenant_id = ${scope.tenantId}
               AND organization_id = ${scope.organizationId}
               AND user_id = ${change.userId}
               AND department_id = ${change.departmentId}
          `);

          user.departmentId = null;
          user.level = 'staff';
          if (dept.headUserId === user.id) dept.headUserId = null;

          await this.audit.record(tx, {
            action: 'department.member.removed',
            entityType: 'user_entity',
            entityId: change.userId,
            before: {
              userId: change.userId,
              departmentId: dept.id,
              departmentName: dept.name,
              level: prevLevel,
            },
            after: {
              userId: change.userId,
              departmentId: null,
              level: 'staff',
            },
            meta: auditMeta,
          });
          break;
        }

        case 'memberMove': {
          const user = runningUsers.get(change.userId);
          const fromDept = runningDepts.get(change.fromDepartmentId);
          const toDept = runningDepts.get(change.toDepartmentId);
          if (!user || !fromDept || !toDept) break;
          const prevLevel = user.level;
          const nextLevel: AccessLevel = prevLevel === 'head' ? 'staff' : prevLevel;

          await tx.execute(sql`
            UPDATE app.user_entities
               SET department_id = ${change.toDepartmentId},
                   level = ${nextLevel}
             WHERE tenant_id = ${scope.tenantId}
               AND organization_id = ${scope.organizationId}
               AND user_id = ${change.userId}
               AND department_id = ${change.fromDepartmentId}
          `);

          if (fromDept.headUserId === user.id) fromDept.headUserId = null;
          user.departmentId = toDept.id;
          user.level = nextLevel;

          await this.audit.record(tx, {
            action: 'department.member.moved',
            entityType: 'user_entity',
            entityId: change.userId,
            before: {
              userId: change.userId,
              departmentId: fromDept.id,
              departmentName: fromDept.name,
              level: prevLevel,
            },
            after: {
              userId: change.userId,
              departmentId: toDept.id,
              departmentName: toDept.name,
              level: nextLevel,
            },
            meta: auditMeta,
          });
          break;
        }

        case 'memberJobTitle': {
          const user = runningUsers.get(change.userId);
          const dept = runningDepts.get(change.departmentId);
          if (!user || !dept || user.jobTitle === change.jobTitle) break;
          const prevJobTitle = user.jobTitle;

          await tx.execute(sql`
            UPDATE app.user_entities
               SET job_title = ${change.jobTitle}
             WHERE tenant_id = ${scope.tenantId}
               AND organization_id = ${scope.organizationId}
               AND user_id = ${change.userId}
               AND department_id = ${change.departmentId}
          `);

          user.jobTitle = change.jobTitle;

          await this.audit.record(tx, {
            action: 'department.member.job_title_changed',
            entityType: 'user_entity',
            entityId: change.userId,
            before: {
              userId: change.userId,
              departmentId: dept.id,
              jobTitle: prevJobTitle,
            },
            after: {
              userId: change.userId,
              departmentId: dept.id,
              jobTitle: change.jobTitle,
            },
            meta: auditMeta,
          });
          break;
        }

        case 'head': {
          const dept = runningDepts.get(change.departmentId);
          if (!dept || dept.headUserId === change.userId) break;
          const prevHeadId = dept.headUserId;

          await tx.execute(sql`
            UPDATE app.departments
               SET head_user_id = ${change.userId},
                   updated_at = now()
             WHERE tenant_id = ${scope.tenantId}
               AND organization_id = ${scope.organizationId}
               AND id = ${change.departmentId}
          `);

          if (prevHeadId !== null) {
            const prevHead = runningUsers.get(prevHeadId);
            if (prevHead && prevHead.departmentId === dept.id && prevHead.level === 'head') {
              prevHead.level = 'manager';
            }
          }
          if (change.userId !== null) {
            const nextHead = runningUsers.get(change.userId);
            if (nextHead && nextHead.departmentId === dept.id) {
              nextHead.level = 'head';
            }
          }
          dept.headUserId = change.userId;

          await this.audit.record(tx, {
            action: 'department.head.changed',
            entityType: 'department',
            entityId: dept.id,
            before: {
              departmentId: dept.id,
              departmentName: dept.name,
              headUserId: prevHeadId,
            },
            after: {
              departmentId: dept.id,
              departmentName: dept.name,
              headUserId: change.userId,
            },
            meta: auditMeta,
          });
          break;
        }
      }
    }

    // Reconcile level rules in app.role_permission_levels for any affected area.
    if (levelRulesActive && levelAreasToReconcile.size > 0) {
      const afterGrantMap = new Map(
        after.grants.map((g) => [grantKey(g.role, g.permission), g.scope]),
      );
      for (const areaKey of levelAreasToReconcile) {
        const afterRule = after.levelRules.find((l) => l.area === areaKey);
        if (afterRule) {
          await this.reconcileLevelRulesForArea(
            tx,
            scope.tenantId,
            areaKey,
            afterRule,
            afterGrantMap,
          );
        }
      }
    }

    // Persist assignment rules and hand-overs for any touched area.
    for (const area of assignmentAreasToPersist) {
      const afterRule = after.assignment.find((a) => a.area === area);
      if (!afterRule) continue;

      await tx.execute(sql`
        INSERT INTO app.access_assignment_rules (
          tenant_id, organization_id, area, staff_rule, managers_rule, updated_at
        )
        VALUES (
          ${scope.tenantId}, ${scope.organizationId}, ${area},
          ${afterRule.staff}, ${afterRule.managers}, now()
        )
        ON CONFLICT (tenant_id, organization_id, area) DO UPDATE
          SET staff_rule = EXCLUDED.staff_rule,
              managers_rule = EXCLUDED.managers_rule,
              updated_at = now()
      `);

      await tx.execute(sql`
        DELETE FROM app.access_assignment_handovers
         WHERE tenant_id = ${scope.tenantId}
           AND organization_id = ${scope.organizationId}
           AND area = ${area}
      `);

      for (const pair of afterRule.handOvers) {
        await tx.execute(sql`
          INSERT INTO app.access_assignment_handovers (
            tenant_id, organization_id, area, from_department_id, to_department_id
          )
          VALUES (
            ${scope.tenantId}, ${scope.organizationId}, ${area},
            ${pair.fromDepartmentId}, ${pair.toDepartmentId}
          )
          ON CONFLICT DO NOTHING
        `);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: snapshot & catalogue assembly
  // ---------------------------------------------------------------------------

  private async loadSnapshot(
    q: AccessQueryable,
    scope: TxScope,
    options: { includeOpenOwned: boolean },
  ): Promise<LoadedSnapshot> {
    const db = q as Db;

    const [revisionRow, rpRes, rplRes, assignment, usersRes, userRolesRes, deptsRes, openOwned] =
      await Promise.all([
        readAccessRevision(db, scope.tenantId),
        db.execute<RolePermissionDbRow>(sql`
          SELECT role_key AS "roleKey", permission, scope, seeded
            FROM app.role_permissions
           WHERE tenant_id = ${scope.tenantId}
        `),
        db.execute<RolePermissionLevelDbRow>(sql`
          SELECT role_key AS "roleKey", permission, min_level AS "minLevel", scope, seeded
            FROM app.role_permission_levels
           WHERE tenant_id = ${scope.tenantId}
        `),
        loadAssignmentConfig(db, scope),
        db.execute<UserDbRow>(sql`
          SELECT u.id,
                 coalesce(nullif(btrim(u.display_name), ''), u.email, 'Unnamed user') AS name,
                 u.email,
                 u.status,
                 (ue.user_id IS NOT NULL) AS "inEntity",
                 ue.department_id AS "departmentId",
                 coalesce(ue.level, 'staff') AS level,
                 ue.job_title AS "jobTitle",
                 ue.role_keys AS "entityRoleKeys",
                 io.party_id AS "partyId"
            FROM app.users u
            LEFT JOIN app.user_entities ue
              ON ue.tenant_id = u.tenant_id
             AND ue.organization_id = ${scope.organizationId}
             AND ue.user_id = u.id
            LEFT JOIN app.idp_orgs io
              ON io.tenant_id = u.tenant_id
             AND io.id = u.idp_org_id
           WHERE u.tenant_id = ${scope.tenantId}
           ORDER BY lower(coalesce(nullif(btrim(u.display_name), ''), u.email, '')), u.id
        `),
        db.execute<UserRoleDbRow>(sql`
          SELECT user_id AS "userId", role_key AS "roleKey"
            FROM app.user_roles
           WHERE tenant_id = ${scope.tenantId}
        `),
        db.execute<DeptDbRow>(sql`
          SELECT id, name, head_user_id AS "headUserId"
            FROM app.departments
           WHERE tenant_id = ${scope.tenantId}
             AND organization_id = ${scope.organizationId}
             AND status = 'active'
           ORDER BY lower(name), id
        `),
        options.includeOpenOwned
          ? this.loadOpenOwnedCounts(db, scope)
          : Promise.resolve(new Map<string, number>()),
      ]);

    const rolesByUser = new Map<string, RoleKey[]>();
    for (const row of userRolesRes.rows) {
      if (!ROLE_KEY_SET.has(row.roleKey)) continue;
      const list = rolesByUser.get(row.userId) ?? [];
      list.push(row.roleKey as RoleKey);
      rolesByUser.set(row.userId, list);
    }

    const partyByUserId = new Map<string, string | null>();
    const users: SnapshotUser[] = usersRes.rows.map((u) => {
      partyByUserId.set(u.id, u.partyId);
      const tokenRoles = rolesByUser.get(u.id) ?? [];
      const effectiveRoles =
        u.inEntity && u.entityRoleKeys !== null
          ? tokenRoles.filter((r) => u.entityRoleKeys!.includes(r))
          : tokenRoles;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        status: u.status,
        roles: effectiveRoles,
        departmentId: u.departmentId,
        level: u.level,
        jobTitle: u.jobTitle,
        inEntity: u.inEntity,
      };
    });

    const departments: SnapshotDepartment[] = deptsRes.rows.map((d) => ({
      id: d.id,
      name: d.name,
      headUserId: d.headUserId,
    }));

    const hasPersistedGrants = rpRes.rows.length > 0;
    const grants = buildGrantRows(hasPersistedGrants, rpRes.rows);
    const levelRules = deriveLevelRules(revisionRow.levelRulesMaterialized, rplRes.rows);

    return {
      revisionRow,
      hasPersistedGrants,
      hasPersistedLevelRows: rplRes.rows.length > 0,
      snapshot: {
        grants,
        levelRules,
        assignment,
        users,
        departments,
        openOwnedCounts: openOwned,
      },
      partyByUserId,
    };
  }

  private buildCatalogueResponse(loaded: LoadedSnapshot): AccessCatalogueResponse {
    const activeRoleCounts = new Map<RoleKey, number>();
    for (const user of loaded.snapshot.users) {
      if (user.status !== 'active') continue;
      for (const role of user.roles) {
        activeRoleCounts.set(role, (activeRoleCounts.get(role) ?? 0) + 1);
      }
    }

    const roles = ACCESS_ROLE_CATALOGUE.map((r) => ({
      ...r,
      peopleCount: activeRoleCounts.get(r.key) ?? 0,
    }));

    const { revisionRow } = loaded;
    const lastChanged =
      revisionRow.updatedAt !== null
        ? { at: revisionRow.updatedAt, byName: revisionRow.updatedByName }
        : null;

    return {
      revision: revisionRow.revision,
      lastChanged,
      roles,
      areas: [...ACCESS_AREA_CATALOGUE],
      groups: [...ACCESS_PERMISSION_GROUPS],
      permissions: [...ACCESS_PERMISSION_CATALOGUE],
      grants: [...loaded.snapshot.grants],
      levelRules: [...loaded.snapshot.levelRules],
      assignment: [...loaded.snapshot.assignment],
      conflicts: [...ACCESS_CONFLICTS],
      summaries: buildAreaSummaries(loaded.snapshot.grants, loaded.snapshot.levelRules),
      assignmentSummaries: buildAssignmentSummaries(loaded.snapshot.assignment),
    };
  }

  /**
   * Counts open records owned by each user across areas that support personal ownership, keyed as
   * `${userId}:${areaKey}`. Drives warning W7 ("losing work").
   */
  private async loadOpenOwnedCounts(db: Db, scope: TxScope): Promise<Map<string, number>> {
    const [leadsRes, oppsRes, quotesRes, prsRes, billsRes, approvalsRes] = await Promise.all([
      db.execute<UserCountDbRow>(sql`
        SELECT owner_user_id AS "userId", count(*)::text AS count
          FROM app.leads
         WHERE tenant_id = ${scope.tenantId}
           AND organization_id = ${scope.organizationId}
           AND owner_user_id IS NOT NULL
           AND stage NOT IN ('converted', 'lost')
         GROUP BY owner_user_id
      `),
      db.execute<UserCountDbRow>(sql`
        SELECT owner_user_id AS "userId", count(*)::text AS count
          FROM app.opportunities
         WHERE tenant_id = ${scope.tenantId}
           AND organization_id = ${scope.organizationId}
           AND owner_user_id IS NOT NULL
           AND stage NOT IN ('won', 'lost')
         GROUP BY owner_user_id
      `),
      db.execute<UserCountDbRow>(sql`
        SELECT q.owner_user_id AS "userId", count(*)::text AS count
          FROM app.quotations q
          JOIN app.quotation_versions qv
            ON qv.tenant_id = q.tenant_id
           AND qv.organization_id = q.organization_id
           AND qv.id = q.current_version_id
         WHERE q.tenant_id = ${scope.tenantId}
           AND q.organization_id = ${scope.organizationId}
           AND q.owner_user_id IS NOT NULL
           AND qv.status IN ('draft', 'submitted', 'returned', 'approved', 'sent')
         GROUP BY q.owner_user_id
      `),
      db.execute<UserCountDbRow>(sql`
        SELECT requester_user_id AS "userId", count(*)::text AS count
          FROM app.purchase_requests
         WHERE tenant_id = ${scope.tenantId}
           AND organization_id = ${scope.organizationId}
           AND status NOT IN ('closed', 'rejected', 'cancelled')
         GROUP BY requester_user_id
      `),
      db.execute<UserCountDbRow>(sql`
        SELECT entered_by AS "userId", count(*)::text AS count
          FROM app.vendor_bills
         WHERE tenant_id = ${scope.tenantId}
           AND organization_id = ${scope.organizationId}
           AND status NOT IN ('paid', 'voided', 'rejected', 'discarded')
         GROUP BY entered_by
      `),
      db.execute<UserCountDbRow>(sql`
        SELECT requester_user_id AS "userId", count(*)::text AS count
          FROM app.approval_requests
         WHERE tenant_id = ${scope.tenantId}
           AND organization_id = ${scope.organizationId}
           AND status IN ('pending', 'returned', 'blocked')
         GROUP BY requester_user_id
      `),
    ]);

    const map = new Map<string, number>();
    const merge = (area: AccessSettingAreaKey, rows: readonly UserCountDbRow[]) => {
      for (const row of rows) {
        const n = Number(row.count);
        if (n > 0) map.set(`${row.userId}:${area}`, n);
      }
    };
    merge('leads', leadsRes.rows);
    merge('opportunities', oppsRes.rows);
    merge('quotations', quotesRes.rows);
    merge('procurement', prsRes.rows);
    merge('payables', billsRes.rows);
    merge('approvals', approvalsRes.rows);
    return map;
  }

  // ---------------------------------------------------------------------------
  // Private: Check a person report (spec 6.2)
  // ---------------------------------------------------------------------------

  private async buildPersonReport(
    db: Db,
    scope: TxScope,
    user: SnapshotUser,
    partyId: string | null,
    state: SimulatedState,
    previous?: {
      user: SnapshotUser;
      grantMap: ReadonlyMap<string, AccessScope | null>;
      levelMap: ReadonlyMap<AccessSettingAreaKey, AccessLevelRule>;
    },
  ): Promise<CheckPersonReport> {
    const grantMap = new Map(state.grants.map((g) => [grantKey(g.role, g.permission), g.scope]));
    const levelMap = new Map(state.levelRules.map((l) => [l.area, l]));
    const deptById = new Map(state.departments.map((d) => [d.id, d]));

    const userDept = user.departmentId ? (deptById.get(user.departmentId) ?? null) : null;

    // Active staff in the acting entity for "Who can assign" candidate lists.
    const candidates: (AssignmentParty & { name: string; departmentName: string | null })[] =
      state.users
        .filter((u) => u.status === 'active' && u.inEntity)
        .map((u) => ({
          userId: u.id,
          roleKeys: u.roles,
          departmentId: u.departmentId,
          level: u.level,
          name: u.name,
          departmentName: u.departmentId ? (deptById.get(u.departmentId)?.name ?? null) : null,
        }));

    const actorParty: AssignmentParty = {
      userId: user.id,
      roleKeys: user.roles,
      departmentId: user.departmentId,
      level: user.level,
    };

    const areaRows: CheckPersonAreaRow[] = await Promise.all(
      ACCESS_SETTING_AREA_KEYS.map(async (areaKey) => {
        const area = AREA_BY_KEY.get(areaKey)!;
        const effective = effectiveScopeForUser(user, area.seePermission, grantMap, levelMap);
        const effScope = user.status === 'inactive' ? null : effective.scope;
        const scopeLabel = reachLabel(effScope, 'record');

        const { visibleCount, totalCount } = await this.countAreaRecords(
          db,
          scope,
          areaKey,
          user,
          partyId,
          effScope,
        );

        const actions: CheckPersonAction[] = [];
        if (user.status !== 'inactive') {
          for (const actionPerm of area.actionPermissions) {
            const actionEff = effectiveScopeForUser(user, actionPerm, grantMap, levelMap);
            if (actionEff.scope !== null) {
              const info = PERMISSION_BY_KEY.get(actionPerm);
              actions.push({
                permission: actionPerm,
                label: info?.label ?? permissionLabel(actionPerm),
                scope: actionEff.scope,
              });
            }
          }
        }

        let assignableCount: number | null = null;
        let assignablePeople: CheckPersonAssignable[] | undefined;
        if (area.hasAssignment) {
          if (user.status === 'inactive' || !user.inEntity) {
            assignableCount = 0;
            assignablePeople = [];
          } else {
            const rule = state.assignment.find((a) => a.area === areaKey);
            const config = toAssignmentRuleConfig(rule, true);
            const targets = assignableTargets(actorParty, candidates, 'reassign', config);
            assignableCount = targets.length;
            assignablePeople = targets.map((t) => ({
              userId: t.userId,
              name: t.name,
              departmentName: t.departmentName,
              level: t.level,
            }));
          }
        }

        const why = explainAreaAccess(user, areaKey, grantMap, levelMap);
        if (user.status === 'inactive') {
          why.unshift('This account is inactive.');
        }

        let previousScopeLabel: string | undefined;
        if (previous) {
          const prevEff = effectiveScopeForUser(
            previous.user,
            area.seePermission,
            previous.grantMap,
            previous.levelMap,
          );
          const prevScope = previous.user.status === 'inactive' ? null : prevEff.scope;
          const prevLabel = reachLabel(prevScope, 'record');
          if (prevLabel !== scopeLabel) {
            previousScopeLabel = prevLabel;
          }
        }

        return {
          area: areaKey,
          label: area.label,
          scope: effScope,
          scopeLabel,
          visibleCount,
          totalCount,
          actions,
          assignableCount,
          ...(assignablePeople === undefined ? {} : { assignablePeople }),
          why,
          ...(previousScopeLabel === undefined ? {} : { previousScopeLabel }),
        };
      }),
    );

    return {
      person: {
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
        roles: user.roles.map((r) => ({ key: r, label: roleLabel(r) })),
        department: userDept ? { id: userDept.id, name: userDept.name } : null,
        level: user.level,
      },
      areas: areaRows,
    };
  }

  private async countAreaRecords(
    db: Db,
    scope: TxScope,
    area: AccessSettingAreaKey,
    user: SnapshotUser,
    partyId: string | null,
    effectiveScope: AccessScope | null,
  ): Promise<{ visibleCount: number; totalCount: number }> {
    const readCount = async (query: ReturnType<typeof sql>): Promise<number> => {
      const res = await db.execute<CountDbRow>(query);
      return Number(res.rows[0]?.count ?? '0');
    };

    const { tenantId, organizationId } = scope;

    switch (area) {
      case 'leads': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.leads
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'department') {
          if (user.departmentId === null) return { visibleCount: 0, totalCount };
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.leads
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND department_id = ${user.departmentId}
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'own') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.leads
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND owner_user_id = ${user.id}
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'assigned') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.leads l
             WHERE l.tenant_id = ${tenantId} AND l.organization_id = ${organizationId}
               AND EXISTS (
                 SELECT 1 FROM app.activities a
                  WHERE a.tenant_id = l.tenant_id
                    AND a.organization_id = l.organization_id
                    AND a.lead_id = l.id
                    AND a.assignee_user_id = ${user.id}
                    AND a.cancelled_at IS NULL
               )
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }

      case 'opportunities': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.opportunities
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'department') {
          if (user.departmentId === null) return { visibleCount: 0, totalCount };
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.opportunities
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND department_id = ${user.departmentId}
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'own') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.opportunities
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND owner_user_id = ${user.id}
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'assigned') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.opportunities o
             WHERE o.tenant_id = ${tenantId} AND o.organization_id = ${organizationId}
               AND EXISTS (
                 SELECT 1 FROM app.activities a
                  WHERE a.tenant_id = o.tenant_id
                    AND a.organization_id = o.organization_id
                    AND a.opportunity_id = o.id
                    AND a.assignee_user_id = ${user.id}
                    AND a.cancelled_at IS NULL
               )
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }

      case 'quotations': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.quotations
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'department') {
          if (user.departmentId === null) return { visibleCount: 0, totalCount };
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count
              FROM app.quotations q
              JOIN app.opportunities o
                ON o.tenant_id = q.tenant_id
               AND o.organization_id = q.organization_id
               AND o.id = q.opportunity_id
             WHERE q.tenant_id = ${tenantId} AND q.organization_id = ${organizationId}
               AND o.department_id = ${user.departmentId}
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'own') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.quotations
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND owner_user_id = ${user.id}
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'customer_org') {
          if (partyId === null) return { visibleCount: 0, totalCount };
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.quotations
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND customer_party_id = ${partyId}
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }

      case 'sales_orders': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.sales_orders
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'own') {
          // Matches sales-orders.service.ts: orders inherit ownership from their quotation.
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.sales_orders so
             WHERE so.tenant_id = ${tenantId} AND so.organization_id = ${organizationId}
               AND EXISTS (
                 SELECT 1 FROM app.quotations q
                  WHERE q.tenant_id = so.tenant_id
                    AND q.organization_id = so.organization_id
                    AND q.id = so.quotation_id
                    AND q.owner_user_id = ${user.id}
               )
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'customer_org') {
          if (partyId === null) return { visibleCount: 0, totalCount };
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.sales_orders
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND customer_party_id = ${partyId}
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }

      case 'invoices': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.invoices
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'own') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.invoices
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND created_by = ${user.id}
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'customer_org') {
          if (partyId === null) return { visibleCount: 0, totalCount };
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.invoices
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND customer_party_id = ${partyId}
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }

      case 'procurement': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.purchase_requests
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'department') {
          if (user.departmentId === null) return { visibleCount: 0, totalCount };
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.purchase_requests
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND department_id = ${user.departmentId}
          `);
          return { visibleCount, totalCount };
        }
        if (effectiveScope === 'own') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.purchase_requests
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND requester_user_id = ${user.id}
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }

      case 'payables': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.vendor_bills
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'own') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.vendor_bills
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND entered_by = ${user.id}
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }

      case 'approvals': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.approval_requests
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'own') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.approval_requests
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND requester_user_id = ${user.id}
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }

      case 'documents': {
        const totalCount = await readCount(sql`
          SELECT count(*)::text AS count FROM app.documents
           WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
             AND removed_at IS NULL
        `);
        if (effectiveScope === null) return { visibleCount: 0, totalCount };
        if (effectiveScope === 'all') return { visibleCount: totalCount, totalCount };
        if (effectiveScope === 'own') {
          const visibleCount = await readCount(sql`
            SELECT count(*)::text AS count FROM app.documents
             WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId}
               AND removed_at IS NULL
               AND created_by = ${user.id}
          `);
          return { visibleCount, totalCount };
        }
        return { visibleCount: 0, totalCount };
      }
    }
  }
}
