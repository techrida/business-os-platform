// Integration tests for AccessSettingsService, /v1/admin/access persistence, warnings, audit trail,
// Check a person live counts, and immediate RoleCache invalidation (Spec 7.1-7.6, 8.1).
// Runs against a real postgres:16-alpine container started by Testcontainers (needs Docker in WSL).
// Run on Linux/WSL with:
//   pnpm --filter @bos/api exec vitest run src/modules/access-settings/access-settings.integration.test.ts
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSION_LEVELS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  ROLE_KEYS,
  type AccessCatalogueResponse,
  type AccessChange,
  type AccessLevel,
  type AccessSettingAreaKey,
  type AccessWarning,
  type Permission,
  type RoleKey,
} from '@bos/contracts';
import { createDepartment, createStaffUser, createTenantWithEntity, leads } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import { type Actor, type TxScope, systemActor, withTx } from '../../platform/db/tx';
import {
  ACCESS_AREA_CATALOGUE,
  ACCESS_ROLE_CATALOGUE,
  levelRulePermissions,
} from './access-catalogue';
import { effectiveScopeForUser } from './access-evaluator';
import { readAccessRevision } from './access-revision';
import { AccessSettingsService } from './access-settings.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
const now = 1_000_000;
const clock = (): number => now;

function userActor(userId: string): Actor {
  return {
    kind: 'user',
    id: userId,
    correlationId: `test-${randomUUID()}`,
  };
}

interface SeededEnv {
  scope: TxScope;
  idpOrgId: string;
  salesDeptId: string;
  marketingDeptId: string;
  founderId: string;
  salesHeadId: string;
  salesStaffAId: string;
  salesStaffBId: string;
  marketingStaffId: string;
  roleCache: RoleCache;
  authz: AuthzService;
  audit: AuditService;
  service: AccessSettingsService;
}

async function createSeededEnv(): Promise<SeededEnv> {
  const tenant = await createTenantWithEntity(appPool);
  const scope: TxScope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };

  const { departmentId: salesDeptId } = await createDepartment(appPool, {
    ...scope,
    name: 'Sales',
  });
  const { departmentId: marketingDeptId } = await createDepartment(appPool, {
    ...scope,
    name: 'Marketing',
  });

  const { userId: founderId } = await createStaffUser(appPool, {
    ...scope,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['founder'],
  });
  const { userId: salesHeadId } = await createStaffUser(appPool, {
    ...scope,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['sales'],
    departmentId: salesDeptId,
  });
  const { userId: salesStaffAId } = await createStaffUser(appPool, {
    ...scope,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['sales'],
    departmentId: salesDeptId,
  });
  const { userId: salesStaffBId } = await createStaffUser(appPool, {
    ...scope,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['sales'],
    departmentId: salesDeptId,
  });
  const { userId: marketingStaffId } = await createStaffUser(appPool, {
    ...scope,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['marketing'],
    departmentId: marketingDeptId,
  });

  // Promote salesHead to head of Sales via withTx (triggers sync departments.head_user_id).
  await withTx(db, scope, systemActor('test-seed'), async (tx) => {
    await tx.execute(sql`
      UPDATE app.user_entities
         SET level = 'head'
       WHERE tenant_id = ${scope.tenantId}
         AND organization_id = ${scope.organizationId}
         AND user_id = ${salesHeadId}
    `);
  });

  const roleCache = new RoleCache(db, clock);
  const authz = new AuthzService(db, roleCache);
  const audit = new AuditService(db);
  const service = new AccessSettingsService(db, authz, audit);

  return {
    scope,
    idpOrgId: tenant.idpOrgId,
    salesDeptId,
    marketingDeptId,
    founderId,
    salesHeadId,
    salesStaffAId,
    salesStaffBId,
    marketingStaffId,
    roleCache,
    authz,
    audit,
    service,
  };
}

async function seedLead(
  scope: TxScope,
  ownerUserId: string,
  number: string,
  title: string,
): Promise<string> {
  const id = randomUUID();
  await withTx(db, scope, systemActor('test-seed'), async (tx) => {
    await tx.execute(sql`
      INSERT INTO app.leads (
        id, tenant_id, organization_id, number, title, source, owner_user_id,
        company_name, contact_name, stage
      )
      VALUES (
        ${id}, ${scope.tenantId}, ${scope.organizationId}, ${number}, ${title},
        'website', ${ownerUserId}, 'Acme Pvt Ltd', 'Sita Sharma', 'new'
      )
    `);
  });
  return id;
}

/** Saves `changes` as the Founder, acknowledging whatever the preview asks to confirm. */
async function saveAcknowledged(
  env: SeededEnv,
  changes: AccessChange[],
): Promise<AccessCatalogueResponse> {
  const current = await env.service.getCatalogue(env.scope);
  const preview = await env.service.preview(env.scope, { changes });
  const acknowledged = [
    ...new Set(preview.warnings.filter((w) => w.severity === 'confirm').map((w) => w.code)),
  ];
  return env.service.save(env.scope, userActor(env.founderId), {
    expectedRevision: current.revision,
    changes,
    acknowledged,
  });
}

async function setMembershipLevel(
  scope: TxScope,
  userId: string,
  level: AccessLevel,
): Promise<void> {
  await withTx(db, scope, systemActor('test-seed'), async (tx) => {
    await tx.execute(sql`
      UPDATE app.user_entities
         SET level = ${level}
       WHERE tenant_id = ${scope.tenantId}
         AND organization_id = ${scope.organizationId}
         AND user_id = ${userId}
    `);
  });
}

/**
 * A seeded tenant: the default grants written out, as the seed does. With `levelRows`, also the
 * default level rows the way migration 0088 writes them, leaving
 * `access_revisions.level_rules_materialized` unset; without, the tenant runs on the code default
 * level rows. A tenant with no grant rows at all is no model here: the first save bumps
 * `authz_versions`, after which the role cache reads its empty grant table as an empty policy.
 */
async function seedPolicy(scope: TxScope, options: { levelRows: boolean }): Promise<void> {
  await withTx(db, scope, systemActor('test-seed'), async (tx) => {
    for (const role of ROLE_KEYS) {
      for (const [permission, grantScope] of Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) {
        if (grantScope === undefined) continue;
        await tx.execute(sql`
          INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
          VALUES (${scope.tenantId}, ${role}, ${permission}, ${grantScope}, true)
          ON CONFLICT (tenant_id, role_key, permission) DO NOTHING
        `);
      }
      if (!options.levelRows) continue;
      for (const row of DEFAULT_ROLE_PERMISSION_LEVELS[role]) {
        await tx.execute(sql`
          INSERT INTO app.role_permission_levels (
            tenant_id, role_key, permission, min_level, scope, seeded
          )
          VALUES (
            ${scope.tenantId}, ${role}, ${row.permission}, ${row.minLevel}, ${row.scope}, true
          )
          ON CONFLICT (tenant_id, role_key, permission, min_level) DO NOTHING
        `);
      }
    }
  });
}

async function liveScope(
  env: SeededEnv,
  roles: readonly RoleKey[],
  level: AccessLevel,
  permission: Permission,
): Promise<string | null> {
  const grants = await env.roleCache.grantsFor(
    env.scope.tenantId,
    env.scope.organizationId,
    roles,
    level,
  );
  return grants.get(permission) ?? null;
}

const DEPARTMENT_AREAS: readonly AccessSettingAreaKey[] = ACCESS_AREA_CATALOGUE.filter(
  (a) => a.supportsDepartment,
).map((a) => a.key);

const switchEveryArea = (managers: boolean, heads: boolean): AccessChange[] =>
  DEPARTMENT_AREAS.map((area): AccessChange => ({
    kind: 'levelRule',
    area,
    managersSeeDepartment: managers,
    headsSeeDepartment: heads,
  }));

function getHttpErrorBody(err: unknown): Record<string, unknown> {
  if (err instanceof ConflictException || err instanceof UnprocessableEntityException) {
    const res = err.getResponse();
    if (typeof res === 'object' && res !== null) return res as Record<string, unknown>;
  }
  throw new Error(`Expected ConflictException or UnprocessableEntityException, got ${String(err)}`);
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('AccessSettingsService integration (real Postgres)', () => {
  it('returns complete catalogue, defaults, Marketing -> Sales handover, and clean summaries on a fresh tenant', async () => {
    const env = await createSeededEnv();
    const cat = await env.service.getCatalogue(env.scope);

    expect(cat.revision).toBe('0');
    expect(cat.lastChanged).toBeNull();
    expect(cat.roles).toHaveLength(ROLE_KEYS.length);
    expect(cat.areas).toHaveLength(9);
    expect(cat.permissions).toHaveLength(PERMISSIONS.length);

    const salesRole = cat.roles.find((r) => r.key === 'sales');
    expect(salesRole?.peopleCount).toBe(3);
    const founderRole = cat.roles.find((r) => r.key === 'founder');
    expect(founderRole?.locked).toBe(true);
    expect(founderRole?.peopleCount).toBe(1);

    // Default Marketing -> Sales hand-over auto-resolved from existing departments.
    const leadsAssign = cat.assignment.find((a) => a.area === 'leads');
    expect(leadsAssign?.staff).toBe('self_and_peers');
    expect(leadsAssign?.managers).toBe('any_at_or_below');
    expect(leadsAssign?.handOvers).toEqual([
      expect.objectContaining({
        fromDepartmentId: env.marketingDeptId,
        toDepartmentId: env.salesDeptId,
        fromDepartmentName: 'Marketing',
        toDepartmentName: 'Sales',
      }),
    ]);

    // Summaries use plain business language only (Spec section 9).
    const allSummaryText = [
      ...Object.values(cat.summaries).flat(),
      ...Object.values(cat.assignmentSummaries),
    ].join(' ');
    expect(allSummaryText).not.toMatch(/\b(scope|grant|RBAC|seeded)\b/i);
  });

  it('materializes default role_permissions on first write, sets seeded=false on edited row, and restores seeded=true on resetRole', async () => {
    const env = await createSeededEnv();
    const initial = await env.service.getCatalogue(env.scope);

    // Give pmo crm.lead.write = 'department' (differs from the default 'own'; no confirm warning: not 'all').
    const afterEdit = await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: initial.revision,
      changes: [{ kind: 'grant', role: 'pmo', permission: 'crm.lead.write', scope: 'department' }],
      note: 'Allow PMO to update their own leads',
      acknowledged: [],
    });

    expect(afterEdit.revision).toBe('1');
    expect(afterEdit.lastChanged?.byName).toBeTruthy();

    // Check materialized rows in app.role_permissions.
    const rpRes = await db.execute<{
      roleKey: string;
      permission: string;
      scope: string;
      seeded: boolean;
    }>(sql`
      SELECT role_key AS "roleKey", permission, scope, seeded
        FROM app.role_permissions
       WHERE tenant_id = ${env.scope.tenantId}
    `);
    const edited = rpRes.rows.find((r) => r.roleKey === 'pmo' && r.permission === 'crm.lead.write');
    expect(edited).toEqual({
      roleKey: 'pmo',
      permission: 'crm.lead.write',
      scope: 'department',
      seeded: false,
    });
    const untouched = rpRes.rows.find(
      (r) => r.roleKey === 'sales' && r.permission === 'crm.lead.read',
    );
    expect(untouched).toEqual({
      roleKey: 'sales',
      permission: 'crm.lead.read',
      scope: DEFAULT_ROLE_PERMISSIONS.sales['crm.lead.read'],
      seeded: true,
    });

    // Reset pmo back to defaults.
    const afterReset = await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: afterEdit.revision,
      changes: [{ kind: 'resetRole', role: 'pmo' }],
      acknowledged: [],
    });
    expect(afterReset.revision).toBe('2');

    const resetGrant = afterReset.grants.find(
      (g) => g.role === 'pmo' && g.permission === 'crm.lead.write',
    );
    expect(resetGrant?.scope).toBe(DEFAULT_ROLE_PERMISSIONS.pmo['crm.lead.write']);
    expect(resetGrant?.isDefault).toBe(true);

    // Every remaining pmo row in app.role_permissions has seeded = true.
    const pmoRows = await db.execute<{ seeded: boolean }>(sql`
      SELECT seeded FROM app.role_permissions
       WHERE tenant_id = ${env.scope.tenantId} AND role_key = 'pmo'
    `);
    expect(pmoRows.rows.length).toBeGreaterThan(0);
    expect(pmoRows.rows.every((r) => r.seeded === true)).toBe(true);

    // Audit trail captured both domain events with exact Spec 7.5 actions.
    const events = await env.audit.list(env.scope, { limit: 1000 });
    const grantEvt = events.find((e) => e.action === 'access.grant.changed');
    expect(grantEvt).toBeDefined();
    expect(grantEvt?.meta).toMatchObject({ note: 'Allow PMO to update their own leads' });
    const resetEvt = events.find((e) => e.action === 'access.role.reset');
    expect(resetEvt).toBeDefined();
    expect(resetEvt?.entityId).toBe('pmo');
  });

  it('materializes level rules into app.role_permission_levels and keeps OFF state even with zero rows', async () => {
    const env = await createSeededEnv();
    const initial = await env.service.getCatalogue(env.scope);

    // Turn managersSeeDepartment OFF on leads.
    const after1 = await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: initial.revision,
      changes: [{ kind: 'levelRule', area: 'leads', managersSeeDepartment: false }],
      acknowledged: [],
    });
    const leadsRule1 = after1.levelRules.find((l) => l.area === 'leads');
    expect(leadsRule1?.managersSeeDepartment).toBe(false);
    expect(leadsRule1?.headsSeeDepartment).toBe(true);
    // Other department-supporting areas preserved their defaults on materialization.
    const oppsRule1 = after1.levelRules.find((l) => l.area === 'opportunities');
    expect(oppsRule1?.managersSeeDepartment).toBe(true);
    expect(oppsRule1?.headsSeeDepartment).toBe(true);

    // Turn headsSeeDepartment OFF on leads as well -> zero rows for crm.lead.read, stays OFF.
    const after2 = await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: after1.revision,
      changes: [{ kind: 'levelRule', area: 'leads', headsSeeDepartment: false }],
      acknowledged: [],
    });
    const leadsRule2 = after2.levelRules.find((l) => l.area === 'leads');
    expect(leadsRule2?.managersSeeDepartment).toBe(false);
    expect(leadsRule2?.headsSeeDepartment).toBe(false);

    const dbRows = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
        FROM app.role_permission_levels
       WHERE tenant_id = ${env.scope.tenantId}
         AND permission = 'crm.lead.read'
    `);
    expect(Number(dbRows.rows[0]?.count ?? '0')).toBe(0);

    const events = await env.audit.list(env.scope, { limit: 1000 });
    expect(events.some((e) => e.action === 'access.level_rule.changed')).toBe(true);
  });

  it('persists assignment rules and empty hand-overs without reverting to Marketing -> Sales', async () => {
    const env = await createSeededEnv();
    const initial = await env.service.getCatalogue(env.scope);

    const saved = await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: initial.revision,
      changes: [
        {
          kind: 'assignment',
          area: 'leads',
          staff: 'self_only',
          managers: 'self_and_staff',
          handOvers: [],
        },
      ],
      acknowledged: [],
    });

    const leadsAssign = saved.assignment.find((a) => a.area === 'leads');
    expect(leadsAssign?.staff).toBe('self_only');
    expect(leadsAssign?.managers).toBe('self_and_staff');
    expect(leadsAssign?.handOvers).toEqual([]);
    expect(saved.assignmentSummaries.leads).toContain('No cross-department hand-overs');

    // Opportunities still has default Marketing -> Sales because it was untouched.
    const oppsAssign = saved.assignment.find((a) => a.area === 'opportunities');
    expect(oppsAssign?.handOvers).toHaveLength(1);

    const events = await env.audit.list(env.scope, { limit: 1000 });
    expect(events.some((e) => e.action === 'access.assignment_rule.changed')).toBe(true);
  });

  it('keeps an unseeded tenant on its default grants when only an assignment rule is saved', async () => {
    // The save invalidates the role cache, which writes the version row; a version row beside an empty grant table
    // reads as a deliberately empty policy, so the Founder would lose Settings itself.
    const env = await createSeededEnv();
    const initial = await env.service.getCatalogue(env.scope);
    await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: initial.revision,
      changes: [
        {
          kind: 'assignment',
          area: 'leads',
          staff: 'self_only',
          managers: 'self_and_staff',
          handOvers: [],
        },
      ],
      acknowledged: [],
    });

    const grants = await env.roleCache.grantsFor(env.scope.tenantId, env.scope.organizationId, [
      'sales',
    ]);
    expect(grants.get('crm.lead.read')).toBe(DEFAULT_ROLE_PERMISSIONS.sales['crm.lead.read']);
    const founder = await env.roleCache.grantsFor(env.scope.tenantId, env.scope.organizationId, [
      'founder',
    ]);
    expect(founder.get('admin.settings.write')).toBe('all');
  });

  it('rejects stale expectedRevision with 409 stale_access and leaves database untouched', async () => {
    const env = await createSeededEnv();
    const initial = await env.service.getCatalogue(env.scope);

    await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: initial.revision,
      changes: [{ kind: 'assignment', area: 'leads', staff: 'self_only' }],
      acknowledged: [],
    });

    let caught: unknown;
    try {
      await env.service.save(env.scope, userActor(env.founderId), {
        expectedRevision: initial.revision,
        changes: [{ kind: 'assignment', area: 'leads', staff: 'any_at_or_below' }],
        acknowledged: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    expect(getHttpErrorBody(caught)).toMatchObject({ code: 'stale_access' });
  });

  it('enforces confirmation_required (409) when skipping preview, and blocks W1/W2/W9 with 422', async () => {
    const env = await createSeededEnv();
    const initial = await env.service.getCatalogue(env.scope);

    // W4 maker-checker conflict: accountant already has invoice.submit; adding invoice.issue needs W4.
    let caughtConfirm: unknown;
    try {
      await env.service.save(env.scope, userActor(env.founderId), {
        expectedRevision: initial.revision,
        changes: [{ kind: 'grant', role: 'accountant', permission: 'invoice.issue', scope: 'all' }],
        acknowledged: [],
      });
    } catch (err) {
      caughtConfirm = err;
    }

    expect(caughtConfirm).toBeInstanceOf(ConflictException);
    const confirmBody = getHttpErrorBody(caughtConfirm);
    expect(confirmBody.code).toBe('confirmation_required');
    const confirmWarnings = confirmBody.warnings as AccessWarning[];
    expect(confirmWarnings.some((w) => w.code === 'W4' && w.severity === 'confirm')).toBe(true);

    // Zero audit rows written on rejected save.
    const auditBeforeAck = await env.audit.list(env.scope, { limit: 1000 });
    expect(auditBeforeAck.some((e) => e.action === 'access.grant.changed')).toBe(false);

    // Re-submit acknowledging W4 -> succeeds and records acknowledged in audit meta.
    const afterAck = await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: initial.revision,
      changes: [{ kind: 'grant', role: 'accountant', permission: 'invoice.issue', scope: 'all' }],
      acknowledged: ['W4'],
      note: 'Small team override',
    });
    expect(afterAck.revision).toBe('1');
    const auditAfterAck = await env.audit.list(env.scope, { limit: 1000 });
    const grantEvt = auditAfterAck.find((e) => e.action === 'access.grant.changed');
    expect(grantEvt?.meta).toMatchObject({ acknowledged: ['W4'], note: 'Small team override' });

    // Blocked: W1 (Founder edit), W2 (admin.roles.write on management), W9 (portal perm on sales).
    for (const [change, expectedCode] of [
      [{ kind: 'grant', role: 'founder', permission: 'crm.lead.read', scope: 'own' }, 'W1'],
      [{ kind: 'grant', role: 'management', permission: 'admin.roles.write', scope: 'all' }, 'W2'],
      [
        { kind: 'grant', role: 'sales', permission: 'portal.invoice.read', scope: 'customer_org' },
        'W9',
      ],
    ] as const) {
      let caughtBlocked: unknown;
      try {
        await env.service.save(env.scope, userActor(env.founderId), {
          expectedRevision: afterAck.revision,
          changes: [change],
          acknowledged: ['W1', 'W2', 'W9'],
        });
      } catch (err) {
        caughtBlocked = err;
      }
      expect(caughtBlocked).toBeInstanceOf(UnprocessableEntityException);
      const body = getHttpErrorBody(caughtBlocked);
      expect(body.code).toBe('unprocessable');
      const warnings = body.warnings as AccessWarning[];
      expect(warnings.some((w) => w.code === expectedCode && w.severity === 'blocked')).toBe(true);
    }
  });

  it('applies department head changes atomically, syncs previous head to manager, and writes audit events', async () => {
    const env = await createSeededEnv();
    const initial = await env.service.getCatalogue(env.scope);

    const saved = await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: initial.revision,
      changes: [{ kind: 'head', departmentId: env.salesDeptId, userId: env.salesStaffAId }],
      acknowledged: [],
    });
    expect(saved.revision).toBe('1');

    // Verify migration 0079 trigger demoted prior head to manager and promoted salesStaffA to head.
    const levelsRes = await db.execute<{ userId: string; level: string }>(sql`
      SELECT user_id AS "userId", level
        FROM app.user_entities
       WHERE tenant_id = ${env.scope.tenantId}
         AND organization_id = ${env.scope.organizationId}
         AND user_id IN (${env.salesHeadId}, ${env.salesStaffAId})
    `);
    const byUser = new Map(levelsRes.rows.map((r) => [r.userId, r.level]));
    expect(byUser.get(env.salesStaffAId)).toBe('head');
    expect(byUser.get(env.salesHeadId)).toBe('manager');

    const events = await env.audit.list(env.scope, { limit: 1000 });
    expect(events.some((e) => e.action === 'department.head.changed')).toBe(true);
  });

  it('computes live Check a person counts and assignablePeople, simulates preview without auditing', async () => {
    const env = await createSeededEnv();
    await seedLead(env.scope, env.salesStaffAId, 'LD-2026-0001', 'Lead owned by A');
    await seedLead(env.scope, env.salesStaffBId, 'LD-2026-0002', 'Lead owned by B');

    const eventsBefore = await env.audit.list(env.scope, { limit: 200 });

    // Live Check a person for salesStaffA (own scope on leads -> 1 of 2 visible).
    const report = await env.service.checkPerson(env.scope, env.salesStaffAId);
    expect(report.person.id).toBe(env.salesStaffAId);
    expect(report.person.department?.name).toBe('Sales');
    const leadsRow = report.areas.find((a) => a.area === 'leads');
    expect(leadsRow?.scope).toBe('own');
    expect(leadsRow?.scopeLabel).toBe('Their own');
    expect(leadsRow?.visibleCount).toBe(1);
    expect(leadsRow?.totalCount).toBe(2);
    expect(leadsRow?.why.length).toBeGreaterThan(0);
    // Staff in Sales can assign to themselves + same-level peer salesStaffB, NOT salesHead (upward).
    const assignableIds = (leadsRow?.assignablePeople ?? []).map((p) => p.userId);
    expect(assignableIds).toContain(env.salesStaffAId);
    expect(assignableIds).toContain(env.salesStaffBId);
    expect(assignableIds).not.toContain(env.salesHeadId);
    expect(leadsRow?.assignableCount).toBe(assignableIds.length);

    // Live Check a person for salesHead (head level -> department scope -> 2 of 2 visible).
    const headReport = await env.service.checkPerson(env.scope, env.salesHeadId);
    const headLeads = headReport.areas.find((a) => a.area === 'leads');
    expect(headLeads?.scope).toBe('department');
    expect(headLeads?.visibleCount).toBe(2);
    expect(headLeads?.totalCount).toBe(2);

    // Live Check a person for marketingStaff (default Marketing -> Sales hand-over at or below level).
    const mktReport = await env.service.checkPerson(env.scope, env.marketingStaffId);
    const mktLeads = mktReport.areas.find((a) => a.area === 'leads');
    const mktAssignable = (mktLeads?.assignablePeople ?? []).map((p) => p.userId);
    expect(mktAssignable).toContain(env.marketingStaffId);
    expect(mktAssignable).toContain(env.salesStaffAId);
    expect(mktAssignable).toContain(env.salesStaffBId);
    expect(mktAssignable).not.toContain(env.salesHeadId);

    // Preview widening sales leads to 'all' with person = salesStaffA.
    const preview = await env.service.preview(env.scope, {
      changes: [{ kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'all' }],
      person: env.salesStaffAId,
    });
    expect(preview.warnings.some((w) => w.code === 'W5' && w.severity === 'confirm')).toBe(true);
    const simLeads = preview.report?.areas.find((a) => a.area === 'leads');
    expect(simLeads?.scope).toBe('all');
    expect(simLeads?.scopeLabel).toBe('Everything');
    expect(simLeads?.previousScopeLabel).toBe('Their own');
    expect(simLeads?.visibleCount).toBe(2);
    expect(simLeads?.totalCount).toBe(2);

    // Neither checkPerson nor preview writes any audit events.
    const eventsAfter = await env.audit.list(env.scope, { limit: 200 });
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it('invalidates RoleCache immediately on save so the next request sees the new scope (Spec 7.6)', async () => {
    const env = await createSeededEnv();
    await seedLead(env.scope, env.salesStaffAId, 'LD-2026-0101', 'Alpha Lead');
    await seedLead(env.scope, env.salesStaffBId, 'LD-2026-0102', 'Beta Lead');

    const queryVisibleLeads = async (): Promise<string[]> => {
      const grants = await env.roleCache.grantsFor(env.scope.tenantId, env.scope.organizationId, [
        'sales',
      ]);
      const p: Principal = {
        userId: env.salesStaffAId,
        zitadelUserId: `z-${env.salesStaffAId}`,
        tenantId: env.scope.tenantId,
        organizationId: env.scope.organizationId,
        orgKind: 'staff',
        partyId: null,
        idpOrgId: env.idpOrgId,
        roles: ['sales'],
        departmentId: env.salesDeptId,
        status: 'active',
        grants,
      };
      const rows = await db
        .select({ id: leads.id })
        .from(leads)
        .where(scopeWhereFor(p, leads, 'crm.lead.read'));
      return rows.map((r) => r.id);
    };

    // Before change: cache warmed -> salesStaffA sees only their own 1 lead.
    expect(await queryVisibleLeads()).toHaveLength(1);

    // Founder widens Sales crm.lead.read from 'own' to 'all' (acknowledging W5).
    const initial = await env.service.getCatalogue(env.scope);
    await env.service.save(env.scope, userActor(env.founderId), {
      expectedRevision: initial.revision,
      changes: [{ kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'all' }],
      acknowledged: ['W5'],
    });

    // Without advancing `now` (still within the 5 s VERSION_CHECK_TTL_MS window), the very next
    // request reloads from Postgres and sees both leads immediately.
    expect(await queryVisibleLeads()).toHaveLength(2);
  });
});

describe('Access Settings level rules match the run-time grants (real Postgres)', () => {
  it('writes the paired edit rows when a tenant on the code defaults first saves a level rule', async () => {
    const env = await createSeededEnv();
    await seedPolicy(env.scope, { levelRows: false });
    expect(await liveScope(env, ['sales'], 'manager', 'crm.lead.write')).toBe('department');
    // Unrelated to leads: the first level-rule save writes every default row out.
    await saveAcknowledged(env, [
      { kind: 'levelRule', area: 'procurement', managersSeeDepartment: true },
    ]);

    // D50: a Sales manager and head still edit the department's leads and opportunities.
    for (const level of ['manager', 'head'] as const) {
      expect(await liveScope(env, ['sales'], level, 'crm.lead.write')).toBe('department');
      expect(await liveScope(env, ['sales'], level, 'crm.opportunity.write')).toBe('department');
    }
    expect(await liveScope(env, ['sales'], 'staff', 'crm.lead.write')).toBe('own');
    // Finance reads every lead (U20a2-Q4) and only starts leads: its managers edit none.
    expect(await liveScope(env, ['finance'], 'manager', 'crm.lead.read')).toBe('all');
    expect(await liveScope(env, ['finance'], 'manager', 'crm.lead.write')).toBe('own');
  });

  it('takes the edit reach away with the switch, and keeps every switch off with zero rows', async () => {
    const env = await createSeededEnv();
    await seedPolicy(env.scope, { levelRows: true });
    expect(await liveScope(env, ['sales'], 'manager', 'crm.lead.write')).toBe('department');

    // Both leads switches off: managers and heads can no longer list the department's leads, and
    // must not edit them by id either.
    await saveAcknowledged(env, [
      { kind: 'levelRule', area: 'leads', managersSeeDepartment: false, headsSeeDepartment: false },
    ]);
    for (const level of ['manager', 'head'] as const) {
      expect(await liveScope(env, ['sales'], level, 'crm.lead.read')).toBe('own');
      expect(await liveScope(env, ['sales'], level, 'crm.lead.write')).toBe('own');
      // The opportunities switch is untouched.
      expect(await liveScope(env, ['sales'], level, 'crm.opportunity.write')).toBe('department');
    }

    // Every switch off: zero level rows, and the rows stay the truth instead of the code defaults.
    const saved = await saveAcknowledged(env, switchEveryArea(false, false));
    const rowCount = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
        FROM app.role_permission_levels
       WHERE tenant_id = ${env.scope.tenantId}
    `);
    expect(Number(rowCount.rows[0]?.count ?? '-1')).toBe(0);
    expect((await readAccessRevision(db, env.scope.tenantId)).levelRulesMaterialized).toBe(true);
    for (const rule of saved.levelRules) {
      expect(rule.managersSeeDepartment, rule.area).toBe(false);
      expect(rule.headsSeeDepartment, rule.area).toBe(false);
    }
    for (const level of ['manager', 'head'] as const) {
      expect(await liveScope(env, ['sales'], level, 'crm.lead.read')).toBe('own');
      expect(await liveScope(env, ['sales'], level, 'crm.opportunity.read')).toBe('own');
      expect(await liveScope(env, ['sales'], level, 'quotation.read')).toBe('own');
      expect(await liveScope(env, ['procurement'], level, 'procurement.pr.read')).toBe(
        await liveScope(env, ['procurement'], 'staff', 'procurement.pr.read'),
      );
    }
  });

  it('gives a role that a grant makes eligible its level rows, as Check a person shows', async () => {
    const env = await createSeededEnv();
    await seedPolicy(env.scope, { levelRows: false });
    // Operations Head reads no leads by default (D50), so the code defaults hold no row for it.
    const saved = await saveAcknowledged(env, [
      { kind: 'grant', role: 'operations_head', permission: 'crm.lead.read', scope: 'own' },
    ]);
    const grantMap = new Map(saved.grants.map((g) => [`${g.role}:${g.permission}`, g.scope]));
    const levelMap = new Map(saved.levelRules.map((l) => [l.area, l]));
    const reported = effectiveScopeForUser(
      { roles: ['operations_head'], departmentId: env.salesDeptId, level: 'manager' },
      'crm.lead.read',
      grantMap,
      levelMap,
    ).scope;
    expect(reported).toBe('department');
    expect(await liveScope(env, ['operations_head'], 'manager', 'crm.lead.read')).toBe(reported);
  });

  it('reports the scope the role cache enforces for every role, level and switch combination', async () => {
    const env = await createSeededEnv();
    await seedPolicy(env.scope, { levelRows: false });
    const managerId = env.salesStaffBId;
    await setMembershipLevel(env.scope, managerId, 'manager');

    const staffRoles = ACCESS_ROLE_CATALOGUE.filter((r) => r.kind === 'staff').map((r) => r.key);
    const roleSets: (readonly RoleKey[])[] = [
      ...staffRoles.map((role) => [role] as const),
      ['sales', 'finance'],
      ['marketing', 'pmo'],
    ];
    // Every permission, so the check also proves no switch widens anything outside its area.
    const permissions: readonly Permission[] = PERMISSIONS;
    expect(DEPARTMENT_AREAS.flatMap((area) => levelRulePermissions(area))).toContain(
      'crm.lead.write',
    );

    // The two mixed combinations are the ones that tell a head's fallback to the manager row apart.
    for (const [managers, heads] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const saved = await saveAcknowledged(env, switchEveryArea(managers, heads));
      const grantMap = new Map(saved.grants.map((g) => [`${g.role}:${g.permission}`, g.scope]));
      const levelMap = new Map(saved.levelRules.map((l) => [l.area, l]));

      for (const roles of roleSets) {
        for (const level of ['staff', 'manager', 'head'] as const) {
          for (const permission of permissions) {
            const reported = effectiveScopeForUser(
              { roles, departmentId: env.salesDeptId, level },
              permission,
              grantMap,
              levelMap,
            ).scope;
            expect(
              await liveScope(env, roles, level, permission),
              `${String([managers, heads])} ${roles.join('+')} ${level} ${permission}`,
            ).toBe(reported);
          }
        }
      }

      // The live Check a person report on a real manager says what the role cache enforces.
      const report = await env.service.checkPerson(env.scope, managerId);
      const leadsRow = report.areas.find((a) => a.area === 'leads');
      expect(leadsRow?.scope ?? null).toBe(
        await liveScope(env, ['sales'], 'manager', 'crm.lead.read'),
      );
      expect(leadsRow?.actions.find((a) => a.permission === 'crm.lead.write')?.scope).toBe(
        await liveScope(env, ['sales'], 'manager', 'crm.lead.write'),
      );
      const headReport = await env.service.checkPerson(env.scope, env.salesHeadId);
      expect(headReport.areas.find((a) => a.area === 'leads')?.scope ?? null).toBe(
        await liveScope(env, ['sales'], 'head', 'crm.lead.read'),
      );
    }
    // Every role x level x permission x four switch states against a live database: it ran past the 5 s default
    // under load (R5 EF2), so it has its own budget.
  }, 180_000);
});

describe('Access save re-checks the caller against the user mirror (U20b-Q3, real Postgres)', () => {
  const assignmentChange: AccessChange[] = [
    { kind: 'assignment', area: 'leads', staff: 'self_only' },
  ];

  async function saveAs(env: SeededEnv, userId: string): Promise<unknown> {
    const current = await env.service.getCatalogue(env.scope);
    try {
      await env.service.save(env.scope, userActor(userId), {
        expectedRevision: current.revision,
        changes: assignmentChange,
        acknowledged: [],
      });
      return null;
    } catch (err) {
      return err;
    }
  }

  function forbiddenBody(err: unknown): Record<string, unknown> {
    expect(err).toBeInstanceOf(ForbiddenException);
    return (err as ForbiddenException).getResponse() as Record<string, unknown>;
  }

  // Regression: before the live check the save trusted the principal built from the sign-in token,
  // so this exact call returned 200 and wrote the change for the former Founder.
  it('refuses with 403 a former Founder whose role was removed after the token was issued (old code: 200)', async () => {
    const env = await createSeededEnv();
    const before = await readAccessRevision(db, env.scope.tenantId);

    await withTx(db, env.scope, systemActor('test-seed'), async (tx) => {
      await tx.execute(sql`
        DELETE FROM app.user_roles
         WHERE tenant_id = ${env.scope.tenantId}
           AND user_id = ${env.founderId}
           AND role_key = 'founder'
      `);
    });

    const err = await saveAs(env, env.founderId);
    expect(forbiddenBody(err)).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
    // Nothing was written: the revision is where it was.
    const after = await readAccessRevision(db, env.scope.tenantId);
    expect(after.revision).toBe(before.revision);
  });

  it('saves the same change while the Founder role is still present', async () => {
    const env = await createSeededEnv();
    const before = await env.service.getCatalogue(env.scope);

    expect(await saveAs(env, env.founderId)).toBeNull();
    const after = await env.service.getCatalogue(env.scope);
    expect(after.revision).not.toBe(before.revision);
  });

  it('refuses a Founder whose membership in the acting entity narrows the role away', async () => {
    const env = await createSeededEnv();
    await withTx(db, env.scope, systemActor('test-seed'), async (tx) => {
      await tx.execute(sql`
        INSERT INTO app.user_roles (tenant_id, user_id, role_key)
        VALUES (${env.scope.tenantId}, ${env.founderId}, 'sales')
      `);
      await tx.execute(sql`
        UPDATE app.user_entities
           SET role_keys = ARRAY['sales']::text[]
         WHERE tenant_id = ${env.scope.tenantId}
           AND organization_id = ${env.scope.organizationId}
           AND user_id = ${env.founderId}
      `);
    });

    expect(forbiddenBody(await saveAs(env, env.founderId))).toMatchObject({
      reason: 'no_permission',
    });
  });

  it("refuses another tenant's Founder acting in this tenant", async () => {
    const env = await createSeededEnv();
    const other = await createTenantWithEntity(appPool);
    const { userId: otherFounderId } = await createStaffUser(appPool, {
      tenantId: other.tenantId,
      organizationId: other.organizationId,
      idpOrgId: other.idpOrgId,
      roleKeys: ['founder'],
    });

    expect(forbiddenBody(await saveAs(env, otherFounderId))).toMatchObject({
      reason: 'no_permission',
    });
  });

  it('refuses a staff user who never held the Founder role', async () => {
    const env = await createSeededEnv();
    expect(forbiddenBody(await saveAs(env, env.salesHeadId))).toMatchObject({
      reason: 'no_permission',
    });
  });
});
