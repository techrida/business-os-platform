// Departments admin service (U20b / US-106): entity-scoped department lifecycle (create, rename,
// retire, restore), unassigned staff discovery, and batched department people/leadership edits.
//
// Invariants:
// - Reads accept either `admin.users.read` or `admin.roles.read` for active staff callers; writes
//   require `admin.roles.write`.
// - Every query is scoped to the caller's `(tenantId, organizationId)`; unknown departments or
//   departments in another tenant/entity return 404.
// - Active department names are unique per legal entity, case-insensitively (trimmed); clashes
//   return 422 on `name`.
// - Retiring a department with active members requires `moveMembersTo` (another active department id
//   or explicit `null` to unassign them) and completes in one transaction; historical records keep
//   their reference to the retired department.
// - Membership and head changes go through `applyDepartmentChanges`, persist in trigger-safe order
//   (matching migration 0079), record one audit entry per change, bump the access revision inside
//   the transaction, and invalidate the authz cache AFTER commit.
import {
  ACCESS_LEVEL_RANK,
  type AccessLevel,
  type AdminDepartmentDetail,
  type AdminDepartmentItem,
  type AdminDepartmentList,
  type AdminDepartmentsQuery,
  type CreateDepartmentBody,
  type DepartmentChange,
  type DepartmentHeadRef,
  type DepartmentMember,
  type DepartmentStatus,
  type RenameDepartmentBody,
  type RestoreDepartmentBody,
  type RetireDepartmentBody,
  type RoleKey,
  RoleKeySchema,
  type UnassignedPeopleQuery,
  type UnassignedPeopleResponse,
  type UnassignedPerson,
  type UpdateDepartmentPeopleBody,
  type UpdateDepartmentPeopleResponse,
} from '@bos/contracts';
import { departments, idpOrgs, scoped, userEntities, userRoles, users } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { type TxScope, withTx } from '../../platform/db/tx';
import { searchPage } from '../../platform/list';
import { ACCESS_REVISION_PORT, type AccessRevisionPort } from './access-revision.port';
import { applyDepartmentChanges, type DepartmentSnapshot } from './department-changes';
import { DepartmentsCaller } from './departments.caller';

type Queryable = Db | DbTransaction;

const ACTIVE_NAME_INDEX = 'departments_tenant_org_active_name_unique';
const MAX_LIST_ROWS = 500;

function displayNameOf(displayName: string | null, email: string | null, userId: string): string {
  const name = displayName?.trim();
  if (name) return name;
  const mail = email?.trim();
  if (mail) return mail;
  return userId;
}

function effectiveRoles(
  tenantRoles: readonly string[],
  entityRoleKeys: readonly string[] | null,
): RoleKey[] {
  const allowed = entityRoleKeys === null ? null : new Set(entityRoleKeys);
  const out: RoleKey[] = [];
  for (const key of tenantRoles) {
    if (allowed !== null && !allowed.has(key)) continue;
    const parsed = RoleKeySchema.safeParse(key);
    if (parsed.success) out.push(parsed.data);
  }
  return [...new Set(out)].sort();
}

function isUniqueConstraint(error: unknown, constraint: string): boolean {
  const check = (candidate: unknown): boolean => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const pg = candidate as { code?: unknown; constraint?: unknown };
    return pg.code === '23505' && pg.constraint === constraint;
  };
  if (check(error)) return true;
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return check((error as { cause?: unknown }).cause);
  }
  return false;
}

function duplicateNameException(name: string): UnprocessableEntityException {
  const message = `A department named "${name}" already exists.`;
  return new UnprocessableEntityException({
    code: 'unprocessable',
    message,
    details: { name: message },
  });
}

function staleDepartmentException(): ConflictException {
  return new ConflictException({
    code: 'conflict',
    message: 'This department was changed by someone else. Reload and try again.',
  });
}

function changeTargetsDepartment(change: DepartmentChange, departmentId: string): boolean {
  if (change.kind === 'memberMove') {
    return change.fromDepartmentId === departmentId || change.toDepartmentId === departmentId;
  }
  return change.departmentId === departmentId;
}

function departmentLockKey(scope: TxScope): string {
  return `departments:${scope.tenantId}:${scope.organizationId}`;
}

@Injectable()
export class DepartmentsAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: DepartmentsCaller,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    @Inject(ACCESS_REVISION_PORT) private readonly revisions: AccessRevisionPort,
  ) {}

  private assertCanRead(): void {
    const p = this.caller.principal();
    if (p.orgKind !== 'staff' || p.status !== 'active') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    const allowed = can(p, 'admin.users.read').allowed || can(p, 'admin.roles.read').allowed;
    if (!allowed) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
  }

  private assertCanWrite(): void {
    const p = this.caller.principal();
    if (p.orgKind !== 'staff' || p.status !== 'active') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    this.authz.assert('admin.roles.write');
  }

  private async lockEntityDepartments(tx: DbTransaction, scope: TxScope): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${departmentLockKey(scope)}::text, 0))`,
    );
  }

  private async assertUniqueActiveName(
    tx: DbTransaction,
    scope: TxScope,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const normalized = name.trim().toLowerCase();
    const conditions = [
      eq(departments.status, 'active'),
      sql`lower(btrim(${departments.name})) = ${normalized}`,
      ...(excludeId !== undefined ? [ne(departments.id, excludeId)] : []),
    ];
    const existing = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(scoped(scope).where(departments, and(...conditions)))
      .limit(1);
    if (existing.length > 0) {
      throw duplicateNameException(name);
    }
  }

  private async rolesByUserId(
    q: Queryable,
    tenantId: string,
    userIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (userIds.length === 0) return map;
    const rows = await q
      .select({ userId: userRoles.userId, roleKey: userRoles.roleKey })
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, tenantId), inArray(userRoles.userId, [...userIds])));
    for (const row of rows) {
      const list = map.get(row.userId);
      if (list === undefined) {
        map.set(row.userId, [row.roleKey]);
      } else {
        list.push(row.roleKey);
      }
    }
    return map;
  }

  private async loadHeadNames(
    q: Queryable,
    tenantId: string,
    headIds: readonly string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (headIds.length === 0) return map;
    const rows = await q
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, [...headIds])));
    for (const row of rows) {
      map.set(row.id, displayNameOf(row.displayName, row.email, row.id));
    }
    return map;
  }

  private async loadDetail(
    q: Queryable,
    scope: TxScope,
    id: string,
  ): Promise<AdminDepartmentDetail> {
    const [dept] = await q
      .select({
        id: departments.id,
        name: departments.name,
        status: departments.status,
        retiredAt: departments.retiredAt,
        headUserId: departments.headUserId,
        version: departments.version,
      })
      .from(departments)
      .where(scoped(scope).where(departments, eq(departments.id, id)))
      .limit(1);

    if (dept === undefined) {
      throw new NotFoundException('Department not found');
    }

    const memberRows = await q
      .select({
        userId: userEntities.userId,
        displayName: users.displayName,
        email: users.email,
        jobTitle: userEntities.jobTitle,
        level: userEntities.level,
        roleKeys: userEntities.roleKeys,
        departmentSince: userEntities.departmentSince,
      })
      .from(userEntities)
      .innerJoin(
        users,
        and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
      )
      .innerJoin(idpOrgs, and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)))
      .where(
        and(
          eq(userEntities.tenantId, scope.tenantId),
          eq(userEntities.organizationId, scope.organizationId),
          eq(userEntities.departmentId, dept.id),
          eq(idpOrgs.kind, 'staff'),
          eq(users.status, 'active'),
        ),
      );

    const roleMap = await this.rolesByUserId(
      q,
      scope.tenantId,
      memberRows.map((m) => m.userId),
    );

    const members: DepartmentMember[] = memberRows
      .map((row) => ({
        userId: row.userId,
        name: displayNameOf(row.displayName, row.email, row.userId),
        email: row.email,
        jobTitle: row.jobTitle,
        level: row.level,
        roles: effectiveRoles(roleMap.get(row.userId) ?? [], row.roleKeys),
        since: row.departmentSince ? row.departmentSince.toISOString() : null,
      }))
      .sort((a, b) => {
        const rankDiff = ACCESS_LEVEL_RANK[b.level] - ACCESS_LEVEL_RANK[a.level];
        if (rankDiff !== 0) return rankDiff;
        const nameDiff = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        if (nameDiff !== 0) return nameDiff;
        return a.userId.localeCompare(b.userId);
      });

    let head: DepartmentHeadRef | null = null;
    if (dept.headUserId !== null) {
      const fromMembers = members.find((m) => m.userId === dept.headUserId);
      if (fromMembers !== undefined) {
        head = { id: fromMembers.userId, name: fromMembers.name };
      } else {
        const headNames = await this.loadHeadNames(q, scope.tenantId, [dept.headUserId]);
        head = {
          id: dept.headUserId,
          name: headNames.get(dept.headUserId) ?? dept.headUserId,
        };
      }
    }

    const managers = members.filter((m) => m.level === 'manager').length;
    const revision = await this.revisions.read(q, scope);

    return {
      id: dept.id,
      name: dept.name,
      status: dept.status,
      retiredAt: dept.retiredAt ? dept.retiredAt.toISOString() : null,
      head,
      managers,
      memberCount: members.length,
      members,
      version: dept.version,
      revision,
    };
  }

  private async loadEntitySnapshot(tx: DbTransaction, scope: TxScope): Promise<DepartmentSnapshot> {
    const deptRows = await tx
      .select({
        id: departments.id,
        name: departments.name,
        status: departments.status,
        headUserId: departments.headUserId,
      })
      .from(departments)
      .where(scoped(scope).where(departments));

    const staffRows = await tx
      .select({
        userId: userEntities.userId,
        displayName: users.displayName,
        email: users.email,
        status: users.status,
        departmentId: userEntities.departmentId,
        level: userEntities.level,
        jobTitle: userEntities.jobTitle,
      })
      .from(userEntities)
      .innerJoin(
        users,
        and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
      )
      .innerJoin(idpOrgs, and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)))
      .where(
        and(
          eq(userEntities.tenantId, scope.tenantId),
          eq(userEntities.organizationId, scope.organizationId),
          eq(idpOrgs.kind, 'staff'),
        ),
      );

    return {
      departments: deptRows,
      people: staffRows.map((row) => ({
        userId: row.userId,
        name: displayNameOf(row.displayName, row.email, row.userId),
        active: row.status === 'active',
        departmentId: row.departmentId,
        level: row.level,
        jobTitle: row.jobTitle,
      })),
    };
  }

  /** GET /v1/admin/departments */
  async list(query: AdminDepartmentsQuery): Promise<AdminDepartmentList> {
    this.assertCanRead();
    const { scope } = this.caller.tx();
    const statuses: readonly DepartmentStatus[] =
      query.status && query.status.length > 0 ? query.status : ['active'];

    const { rows: deptRows } = await searchPage(this.db, {
      q: query.q,
      columns: [departments.name],
      where: scoped(scope).where(departments, inArray(departments.status, [...statuses])),
      orderBy: [asc(sql`lower(${departments.name})`), asc(departments.id)],
      limit: MAX_LIST_ROWS,
      offset: 0,
      rows: (tx, page) =>
        tx
          .select({
            id: departments.id,
            name: departments.name,
            status: departments.status,
            retiredAt: departments.retiredAt,
            headUserId: departments.headUserId,
            version: departments.version,
          })
          .from(departments)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      count: (tx, where) => tx.$count(departments, where),
    });

    // Aggregate active staff counts for this legal entity in a single pass.
    const membershipRows = await this.db
      .select({
        departmentId: userEntities.departmentId,
        level: userEntities.level,
      })
      .from(userEntities)
      .innerJoin(
        users,
        and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
      )
      .innerJoin(idpOrgs, and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)))
      .where(
        and(
          eq(userEntities.tenantId, scope.tenantId),
          eq(userEntities.organizationId, scope.organizationId),
          eq(idpOrgs.kind, 'staff'),
          eq(users.status, 'active'),
        ),
      );

    let unassigned = 0;
    const memberCounts = new Map<string, number>();
    const managerCounts = new Map<string, number>();
    for (const row of membershipRows) {
      if (row.departmentId === null) {
        unassigned += 1;
        continue;
      }
      memberCounts.set(row.departmentId, (memberCounts.get(row.departmentId) ?? 0) + 1);
      if (row.level === 'manager') {
        managerCounts.set(row.departmentId, (managerCounts.get(row.departmentId) ?? 0) + 1);
      }
    }

    const headIds = [
      ...new Set(deptRows.flatMap((d) => (d.headUserId === null ? [] : [d.headUserId]))),
    ];
    const headNames = await this.loadHeadNames(this.db, scope.tenantId, headIds);

    const items: AdminDepartmentItem[] = deptRows.map((dept) => ({
      id: dept.id,
      name: dept.name,
      status: dept.status,
      retiredAt: dept.retiredAt ? dept.retiredAt.toISOString() : null,
      head:
        dept.headUserId === null
          ? null
          : { id: dept.headUserId, name: headNames.get(dept.headUserId) ?? dept.headUserId },
      managers: managerCounts.get(dept.id) ?? 0,
      members: memberCounts.get(dept.id) ?? 0,
      version: dept.version,
    }));

    return { items, unassigned };
  }

  /** GET /v1/admin/departments/unassigned */
  async listUnassigned(query: UnassignedPeopleQuery): Promise<UnassignedPeopleResponse> {
    this.assertCanRead();
    const { scope } = this.caller.tx();

    const baseWhere = and(
      eq(userEntities.tenantId, scope.tenantId),
      eq(userEntities.organizationId, scope.organizationId),
      isNull(userEntities.departmentId),
      eq(idpOrgs.kind, 'staff'),
      eq(users.status, 'active'),
    );

    const { rows, total } = await searchPage(this.db, {
      q: query.q,
      columns: [users.displayName, users.email],
      where: baseWhere,
      orderBy: [
        asc(sql`lower(coalesce(${users.displayName}, ${users.email}, ${users.id}::text))`),
        asc(userEntities.userId),
      ],
      limit: MAX_LIST_ROWS,
      offset: 0,
      rows: (tx, page) =>
        tx
          .select({
            userId: userEntities.userId,
            displayName: users.displayName,
            email: users.email,
            jobTitle: userEntities.jobTitle,
            roleKeys: userEntities.roleKeys,
          })
          .from(userEntities)
          .innerJoin(
            users,
            and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
          )
          .innerJoin(
            idpOrgs,
            and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)),
          )
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      count: async (tx, where) => {
        const res = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(userEntities)
          .innerJoin(
            users,
            and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
          )
          .innerJoin(
            idpOrgs,
            and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)),
          )
          .where(where);
        return res[0]?.count ?? 0;
      },
    });

    const roleMap = await this.rolesByUserId(
      this.db,
      scope.tenantId,
      rows.map((r) => r.userId),
    );

    const items: UnassignedPerson[] = rows.map((row) => ({
      userId: row.userId,
      name: displayNameOf(row.displayName, row.email, row.userId),
      email: row.email,
      jobTitle: row.jobTitle,
      roles: effectiveRoles(roleMap.get(row.userId) ?? [], row.roleKeys),
    }));

    return { items, total };
  }

  /** GET /v1/admin/departments/:id */
  getById(id: string): Promise<AdminDepartmentDetail> {
    this.assertCanRead();
    const { scope } = this.caller.tx();
    return this.loadDetail(this.db, scope, id);
  }

  /** POST /v1/admin/departments */
  async create(body: CreateDepartmentBody): Promise<AdminDepartmentDetail> {
    this.assertCanWrite();
    const { scope, actor } = this.caller.tx();
    const headUserId = body.headUserId ?? null;

    let detail: AdminDepartmentDetail;
    try {
      detail = await withTx(this.db, scope, actor, async (tx) => {
        await this.lockEntityDepartments(tx, scope);
        await this.assertUniqueActiveName(tx, scope, body.name);

        let headBefore: {
          departmentId: string | null;
          level: AccessLevel;
        } | null = null;

        if (headUserId !== null) {
          const [headRow] = await tx
            .select({
              userId: userEntities.userId,
              departmentId: userEntities.departmentId,
              level: userEntities.level,
              status: users.status,
            })
            .from(userEntities)
            .innerJoin(
              users,
              and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
            )
            .innerJoin(
              idpOrgs,
              and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)),
            )
            .where(
              and(
                eq(userEntities.tenantId, scope.tenantId),
                eq(userEntities.organizationId, scope.organizationId),
                eq(userEntities.userId, headUserId),
                eq(idpOrgs.kind, 'staff'),
              ),
            )
            .limit(1);

          if (headRow === undefined || headRow.status !== 'active') {
            const msg = 'Department head must be an active staff member of this legal entity.';
            throw new UnprocessableEntityException({
              code: 'unprocessable',
              message: msg,
              details: { headUserId: msg },
            });
          }
          headBefore = {
            departmentId: headRow.departmentId,
            level: headRow.level,
          };
        }

        const [created] = await tx
          .insert(departments)
          .values({
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            name: body.name,
            headUserId,
            status: 'active',
            version: 1,
          })
          .returning({ id: departments.id });

        if (created === undefined) {
          throw new Error('departments insert returned no row');
        }

        await this.audit.record(tx, {
          action: 'department.created',
          entityType: 'departments',
          entityId: created.id,
          after: { name: body.name, headUserId, status: 'active', version: 1 },
        });

        if (headUserId !== null && headBefore !== null) {
          // Migration 0079's trigger clears any previous department head_user_id and keeps the new
          // department's head_user_id in sync; migration 0086 sets department_since = now().
          await tx
            .update(userEntities)
            .set({ departmentId: created.id, level: 'head' })
            .where(
              and(
                eq(userEntities.tenantId, scope.tenantId),
                eq(userEntities.organizationId, scope.organizationId),
                eq(userEntities.userId, headUserId),
              ),
            );

          if (headBefore.departmentId !== null) {
            await this.audit.record(tx, {
              action: 'department.member.moved',
              entityType: 'departments',
              entityId: created.id,
              before: { departmentId: headBefore.departmentId, level: headBefore.level },
              after: { departmentId: created.id, level: 'head' },
              meta: { userId: headUserId },
            });
            if (headBefore.level === 'head') {
              await this.audit.record(tx, {
                action: 'department.head.changed',
                entityType: 'departments',
                entityId: headBefore.departmentId,
                before: { headUserId },
                after: { headUserId: null },
                meta: { userId: null },
              });
            }
          } else {
            await this.audit.record(tx, {
              action: 'department.member.added',
              entityType: 'departments',
              entityId: created.id,
              before: { departmentId: null, level: headBefore.level },
              after: { departmentId: created.id, level: 'head' },
              meta: { userId: headUserId },
            });
          }

          await this.audit.record(tx, {
            action: 'department.head.changed',
            entityType: 'departments',
            entityId: created.id,
            before: { headUserId: null },
            after: { headUserId },
            meta: { userId: headUserId },
          });

          await this.revisions.bump(tx, scope);
        }

        return this.loadDetail(tx, scope, created.id);
      });
    } catch (error) {
      if (isUniqueConstraint(error, ACTIVE_NAME_INDEX)) {
        throw duplicateNameException(body.name);
      }
      throw error;
    }

    if (headUserId !== null) {
      await this.authz.invalidate(scope.tenantId, scope.organizationId);
    }
    return detail;
  }

  /** PATCH /v1/admin/departments/:id */
  async rename(id: string, body: RenameDepartmentBody): Promise<AdminDepartmentDetail> {
    this.assertCanWrite();
    const { scope, actor } = this.caller.tx();

    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        await this.lockEntityDepartments(tx, scope);

        const [dept] = await tx
          .select({
            id: departments.id,
            name: departments.name,
            status: departments.status,
            version: departments.version,
          })
          .from(departments)
          .where(scoped(scope).where(departments, eq(departments.id, id)))
          .limit(1);

        if (dept === undefined) {
          throw new NotFoundException('Department not found');
        }
        if (dept.version !== body.expectedVersion) {
          throw staleDepartmentException();
        }
        if (dept.status === 'active') {
          await this.assertUniqueActiveName(tx, scope, body.name, dept.id);
        }

        const nextVersion = dept.version + 1;
        const updated = await tx
          .update(departments)
          .set({
            name: body.name,
            version: nextVersion,
            updatedAt: sql`now()`,
          })
          .where(
            scoped(scope).where(
              departments,
              and(eq(departments.id, dept.id), eq(departments.version, body.expectedVersion)),
            ),
          )
          .returning({ id: departments.id });

        if (updated.length === 0) {
          throw staleDepartmentException();
        }

        await this.audit.record(tx, {
          action: 'department.renamed',
          entityType: 'departments',
          entityId: dept.id,
          before: { name: dept.name, version: dept.version },
          after: { name: body.name, version: nextVersion },
        });

        return this.loadDetail(tx, scope, dept.id);
      });
    } catch (error) {
      if (isUniqueConstraint(error, ACTIVE_NAME_INDEX)) {
        throw duplicateNameException(body.name);
      }
      throw error;
    }
  }

  /** POST /v1/admin/departments/:id/retire */
  async retire(id: string, body: RetireDepartmentBody): Promise<AdminDepartmentDetail> {
    this.assertCanWrite();
    const { scope, actor } = this.caller.tx();

    const { detail, shouldInvalidate } = await withTx(this.db, scope, actor, async (tx) => {
      await this.lockEntityDepartments(tx, scope);

      const [dept] = await tx
        .select({
          id: departments.id,
          name: departments.name,
          status: departments.status,
          headUserId: departments.headUserId,
          version: departments.version,
        })
        .from(departments)
        .where(scoped(scope).where(departments, eq(departments.id, id)))
        .limit(1);

      if (dept === undefined) {
        throw new NotFoundException('Department not found');
      }
      if (dept.version !== body.expectedVersion) {
        throw staleDepartmentException();
      }
      if (dept.status === 'retired') {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: 'This department is already retired.',
        });
      }

      const activeMembers = await tx
        .select({
          userId: userEntities.userId,
          level: userEntities.level,
        })
        .from(userEntities)
        .innerJoin(
          users,
          and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
        )
        .innerJoin(
          idpOrgs,
          and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)),
        )
        .where(
          and(
            eq(userEntities.tenantId, scope.tenantId),
            eq(userEntities.organizationId, scope.organizationId),
            eq(userEntities.departmentId, dept.id),
            eq(idpOrgs.kind, 'staff'),
            eq(users.status, 'active'),
          ),
        );

      let touchedAccess = dept.headUserId !== null;

      if (activeMembers.length > 0) {
        if (body.moveMembersTo === undefined) {
          const message = `Cannot retire ${dept.name} while ${activeMembers.length} active member(s) remain. Choose a destination department or explicitly unassign them.`;
          throw new UnprocessableEntityException({
            code: 'unprocessable',
            message,
            details: {
              moveMembersTo: 'Required while active members remain in this department.',
              activeMembers: activeMembers.length,
            },
          });
        }

        const memberIds = activeMembers.map((m) => m.userId);
        if (body.moveMembersTo !== null) {
          if (body.moveMembersTo === dept.id) {
            const message =
              'Destination department must be different from the department being retired.';
            throw new UnprocessableEntityException({
              code: 'unprocessable',
              message,
              details: { moveMembersTo: message },
            });
          }
          const [target] = await tx
            .select({ id: departments.id, status: departments.status })
            .from(departments)
            .where(scoped(scope).where(departments, eq(departments.id, body.moveMembersTo)))
            .limit(1);
          if (target === undefined || target.status !== 'active') {
            const message =
              'Destination department must be an active department in this legal entity.';
            throw new UnprocessableEntityException({
              code: 'unprocessable',
              message,
              details: { moveMembersTo: message },
            });
          }

          // Demote any moved head to manager so migration 0079's trigger does not replace the
          // destination department's head.
          const movedHeadIds = activeMembers.filter((m) => m.level === 'head').map((m) => m.userId);
          const movedOtherIds = activeMembers
            .filter((m) => m.level !== 'head')
            .map((m) => m.userId);
          if (movedHeadIds.length > 0) {
            await tx
              .update(userEntities)
              .set({ departmentId: target.id, level: 'manager' })
              .where(
                and(
                  eq(userEntities.tenantId, scope.tenantId),
                  eq(userEntities.organizationId, scope.organizationId),
                  inArray(userEntities.userId, movedHeadIds),
                ),
              );
          }
          if (movedOtherIds.length > 0) {
            await tx
              .update(userEntities)
              .set({ departmentId: target.id })
              .where(
                and(
                  eq(userEntities.tenantId, scope.tenantId),
                  eq(userEntities.organizationId, scope.organizationId),
                  inArray(userEntities.userId, movedOtherIds),
                ),
              );
          }

          for (const member of activeMembers) {
            const nextLevel: AccessLevel = member.level === 'head' ? 'manager' : member.level;
            await this.audit.record(tx, {
              action: 'department.member.moved',
              entityType: 'departments',
              entityId: target.id,
              before: { departmentId: dept.id, level: member.level },
              after: { departmentId: target.id, level: nextLevel },
              meta: { userId: member.userId, reason: 'department_retired' },
            });
          }
        } else {
          // Explicit null: unassign all active members and reset level to staff (0079 check).
          await tx
            .update(userEntities)
            .set({ departmentId: null, level: 'staff' })
            .where(
              and(
                eq(userEntities.tenantId, scope.tenantId),
                eq(userEntities.organizationId, scope.organizationId),
                inArray(userEntities.userId, memberIds),
              ),
            );

          for (const member of activeMembers) {
            await this.audit.record(tx, {
              action: 'department.member.removed',
              entityType: 'departments',
              entityId: dept.id,
              before: { departmentId: dept.id, level: member.level },
              after: { departmentId: null, level: 'staff' },
              meta: { userId: member.userId, reason: 'department_retired' },
            });
          }
        }

        if (dept.headUserId !== null) {
          await this.audit.record(tx, {
            action: 'department.head.changed',
            entityType: 'departments',
            entityId: dept.id,
            before: { headUserId: dept.headUserId },
            after: { headUserId: null },
            meta: { userId: null, reason: 'department_retired' },
          });
        }
        touchedAccess = true;
      }

      const nextVersion = dept.version + 1;
      const updated = await tx
        .update(departments)
        .set({
          status: 'retired',
          retiredAt: sql`now()`,
          headUserId: null,
          version: nextVersion,
          updatedAt: sql`now()`,
        })
        .where(
          scoped(scope).where(
            departments,
            and(eq(departments.id, dept.id), eq(departments.version, body.expectedVersion)),
          ),
        )
        .returning({ id: departments.id });

      if (updated.length === 0) {
        throw staleDepartmentException();
      }

      await this.audit.record(tx, {
        action: 'department.retired',
        entityType: 'departments',
        entityId: dept.id,
        before: { status: 'active', headUserId: dept.headUserId, version: dept.version },
        after: {
          status: 'retired',
          headUserId: null,
          version: nextVersion,
          moveMembersTo: body.moveMembersTo ?? null,
          movedCount: activeMembers.length,
        },
      });

      if (touchedAccess) {
        await this.revisions.bump(tx, scope);
      }

      return {
        detail: await this.loadDetail(tx, scope, dept.id),
        shouldInvalidate: touchedAccess,
      };
    });

    if (shouldInvalidate) {
      await this.authz.invalidate(scope.tenantId, scope.organizationId);
    }
    return detail;
  }

  /** POST /v1/admin/departments/:id/restore */
  async restore(id: string, body: RestoreDepartmentBody): Promise<AdminDepartmentDetail> {
    this.assertCanWrite();
    const { scope, actor } = this.caller.tx();

    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        await this.lockEntityDepartments(tx, scope);

        const [dept] = await tx
          .select({
            id: departments.id,
            name: departments.name,
            status: departments.status,
            version: departments.version,
          })
          .from(departments)
          .where(scoped(scope).where(departments, eq(departments.id, id)))
          .limit(1);

        if (dept === undefined) {
          throw new NotFoundException('Department not found');
        }
        if (dept.version !== body.expectedVersion) {
          throw staleDepartmentException();
        }
        if (dept.status === 'active') {
          throw new UnprocessableEntityException({
            code: 'unprocessable',
            message: 'This department is already active.',
          });
        }

        await this.assertUniqueActiveName(tx, scope, dept.name, dept.id);

        const nextVersion = dept.version + 1;
        const updated = await tx
          .update(departments)
          .set({
            status: 'active',
            retiredAt: null,
            version: nextVersion,
            updatedAt: sql`now()`,
          })
          .where(
            scoped(scope).where(
              departments,
              and(eq(departments.id, dept.id), eq(departments.version, body.expectedVersion)),
            ),
          )
          .returning({ id: departments.id });

        if (updated.length === 0) {
          throw staleDepartmentException();
        }

        await this.audit.record(tx, {
          action: 'department.restored',
          entityType: 'departments',
          entityId: dept.id,
          before: { status: 'retired', version: dept.version },
          after: { status: 'active', version: nextVersion },
        });

        return this.loadDetail(tx, scope, dept.id);
      });
    } catch (error) {
      if (isUniqueConstraint(error, ACTIVE_NAME_INDEX)) {
        // Re-read name is unnecessary; a generic name clash message still gives 422 on `name`.
        const message =
          'Another active department already uses this name. Rename it before restoring.';
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message,
          details: { name: message },
        });
      }
      throw error;
    }
  }

  /** POST /v1/admin/departments/:id/people */
  async updatePeople(
    id: string,
    body: UpdateDepartmentPeopleBody,
  ): Promise<UpdateDepartmentPeopleResponse> {
    this.assertCanWrite();
    const { scope, actor } = this.caller.tx();

    for (const change of body.changes) {
      if (!changeTargetsDepartment(change, id)) {
        const message = 'Every change in this request must apply to this department.';
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message,
          details: { changes: message },
        });
      }
    }

    const response = await withTx(this.db, scope, actor, async (tx) => {
      await this.lockEntityDepartments(tx, scope);

      const [dept] = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(scoped(scope).where(departments, eq(departments.id, id)))
        .limit(1);

      if (dept === undefined) {
        throw new NotFoundException('Department not found');
      }

      // Check optimistic concurrency and reserve the next revision inside this transaction.
      // Any validation error below rolls the whole transaction (including this bump) back.
      const nextRevision = await this.revisions.bump(tx, scope, body.expectedRevision);

      const snapshot = await this.loadEntitySnapshot(tx, scope);
      const applied = applyDepartmentChanges(snapshot, body.changes);
      if (!applied.ok) {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: applied.error.message,
          details: { [applied.error.field]: applied.error.message },
        });
      }

      const nextPeopleById = new Map(applied.next.people.map((p) => [p.userId, p]));
      const nextDeptsById = new Map(applied.next.departments.map((d) => [d.id, d]));

      const demotionsAndNonHeads: string[] = [];
      const headPromotions: string[] = [];
      for (const userId of applied.changedUserIds) {
        const nextPerson = nextPeopleById.get(userId);
        if (nextPerson === undefined) continue;
        if (nextPerson.level === 'head') {
          headPromotions.push(userId);
        } else {
          demotionsAndNonHeads.push(userId);
        }
      }

      // Phase 1: apply removals, non-head moves, job-title edits, and head demotions first so
      // outgoing heads release their department's head_user_id before any new head is promoted.
      for (const userId of demotionsAndNonHeads) {
        const nextPerson = nextPeopleById.get(userId);
        if (nextPerson === undefined) continue;
        await tx
          .update(userEntities)
          .set({
            departmentId: nextPerson.departmentId,
            level: nextPerson.level,
            jobTitle: nextPerson.jobTitle,
          })
          .where(
            and(
              eq(userEntities.tenantId, scope.tenantId),
              eq(userEntities.organizationId, scope.organizationId),
              eq(userEntities.userId, userId),
            ),
          );
      }

      // Phase 2: apply promotions to head; migration 0079's trigger updates departments.head_user_id.
      for (const userId of headPromotions) {
        const nextPerson = nextPeopleById.get(userId);
        if (nextPerson === undefined) continue;
        await tx
          .update(userEntities)
          .set({
            departmentId: nextPerson.departmentId,
            level: nextPerson.level,
            jobTitle: nextPerson.jobTitle,
          })
          .where(
            and(
              eq(userEntities.tenantId, scope.tenantId),
              eq(userEntities.organizationId, scope.organizationId),
              eq(userEntities.userId, userId),
            ),
          );
      }

      // Phase 3: ensure any department whose final head is null (for example if an inactive head
      // was cleared) has head_user_id = NULL, and stamp updated_at on touched departments.
      for (const deptId of applied.changedDepartmentIds) {
        const nextDept = nextDeptsById.get(deptId);
        if (nextDept === undefined) continue;
        if (nextDept.headUserId === null) {
          await tx
            .update(departments)
            .set({ headUserId: null, updatedAt: sql`now()` })
            .where(scoped(scope).where(departments, eq(departments.id, deptId)));
        } else {
          await tx
            .update(departments)
            .set({ updatedAt: sql`now()` })
            .where(scoped(scope).where(departments, eq(departments.id, deptId)));
        }
      }

      for (const entry of applied.auditEntries) {
        await this.audit.record(tx, {
          action: entry.action,
          entityType: 'departments',
          entityId: entry.departmentId,
          before: entry.before,
          after: entry.after,
          meta: {
            ...(entry.userId !== null ? { userId: entry.userId } : {}),
            summary: entry.summary,
            ...(body.note !== undefined ? { note: body.note } : {}),
            ...(body.acknowledged !== undefined ? { acknowledged: body.acknowledged } : {}),
            revision: nextRevision,
          },
        });
      }

      const detail = await this.loadDetail(tx, scope, id);
      return {
        ...detail,
        applied: [...applied.effects],
      };
    });

    // Invalidate authz cache AFTER the transaction commits so no reload caches stale data.
    await this.authz.invalidate(scope.tenantId, scope.organizationId);
    return response;
  }
}
