import 'reflect-metadata';

import type { Permission } from '@bos/contracts';
import { Reflector } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import { can } from '../../platform/authz/can';
import { CAN_KEY } from '../../platform/authz/decorators';
import type { Principal } from '../../platform/authz/principal';
import {
  AdminApprovalGroupsController,
  AdminDelegationsController,
  AdminWorkflowsController,
} from './admin-workflows.controller';
import { ApprovalsAdminService } from './admin.service';
import type { ApprovalsCaller } from './ports';

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
};
const after = '33333333-3333-4333-8333-333333333333';
const principal = (permission: Permission): Principal => ({
  ...scope,
  userId: after,
  zitadelUserId: 'caller',
  idpOrgId: after,
  orgKind: 'staff',
  partyId: null,
  roles: [],
  departmentId: null,
  status: 'active',
  grants: new Map([[permission, 'all']]),
});

for (const [Controller, permission] of [
  [AdminWorkflowsController, 'approvals.definitions.write'],
  [AdminApprovalGroupsController, 'approvals.groups.write'],
  [AdminDelegationsController, 'approvals.delegations.write'],
] as const) {
  describe(permission, () => {
    it('requires its own management grant while general directory access remains denied', async () => {
      const required = new Reflector().get<Permission>(CAN_KEY, Controller.prototype.people);
      expect(required).toBe(permission);
      expect(can(principal(permission), required).allowed).toBe(true);
      expect(can(principal('admin.users.read'), required).allowed).toBe(false);
      expect(can(principal(permission), 'admin.users.read').allowed).toBe(false);
      const listAssignmentPeople = vi.fn().mockResolvedValue({ items: [], nextAfter: null });
      // The workflows controller also takes the db and role cache for its publish re-check; people() uses neither.
      const controller = new (Controller as typeof AdminApprovalGroupsController)({
        listAssignmentPeople,
      } as unknown as ApprovalsAdminService);
      await controller.people({ limit: '200', after });
      expect(listAssignmentPeople).toHaveBeenCalledWith({ limit: 200, after });
      expect(() => controller.people({ tenantId: scope.tenantId })).toThrow();
      expect(() => controller.people({ limit: 201 })).toThrow();
    });
  });
}

it('binds the authenticated tenant and entity in the real generated SQL and returns only picker fields', async () => {
  const query = vi
    .fn()
    // The people, then (none has a department) no department lookup: the role line is null.
    .mockResolvedValue({ rows: [[after, 'Mina', 'mina@example.test', null, null]] });
  const db = drizzle({ client: { query } as never });
  const caller = { current: () => ({ scope }) } as ApprovalsCaller;
  const admin = new ApprovalsAdminService(db, { record: vi.fn() }, caller, () => new Date());
  expect(await admin.listAssignmentPeople({ limit: 1, after })).toEqual({
    items: [{ id: after, displayName: 'Mina', email: 'mina@example.test', role: null }],
    nextAfter: after,
  });
  const [config, params] = query.mock.calls[0]! as unknown as [{ text: string }, unknown[]];
  expect(config.text).toContain('"users"."tenant_id" = $');
  expect(config.text).toContain('"user_entities"."organization_id" = $');
  expect(config.text).toContain('"user_entities"."tenant_id" = "app"."users"."tenant_id"');
  expect(config.text).toContain('"idp_orgs"."tenant_id" = "app"."users"."tenant_id"');
  expect(config.text).toContain('"users"."id" > $');
  expect(config.text).toContain('order by "app"."users"."id" asc limit $');
  expect(config.text).not.toContain('roles');
  expect(params).toEqual([scope.organizationId, scope.tenantId, 'active', 'staff', after, 1]);
  query.mockResolvedValueOnce({ rows: [] });
  expect(await admin.listAssignmentPeople({ limit: 1, after })).toEqual({
    items: [],
    nextAfter: null,
  });
});
