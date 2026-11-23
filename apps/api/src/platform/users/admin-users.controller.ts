// Admin routes for users: list, invite, set roles.
// Serves the NFR "role assignment has one source of truth": every change goes to ZITADEL first, then
// the mirror, then the authz cache is invalidated, so the token, the mirror and the cache agree.
import {
  ADMIN_USERS_MAX_PAGE,
  AccessLevelSchema,
  AdminUsersQuerySchema,
  RoleKeySchema,
} from '@bos/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';

import { AuthzService } from '../authz/authz.service';
import { Can } from '../authz/decorators';
import { type LiveGrantDeps, assertLiveGrant } from '../authz/live-grants';
import { principal } from '../authz/principal';
import { RoleCache } from '../authz/role-cache';
import { requestTx } from '../db/tx';
import { type HeaderTarget, setTotalCount } from '../list';
import { type UserStatusAction, UserStatusService } from './user-status';
import { UsersService } from './users.service';
import { UsersStore } from './users.store';
import { ZitadelNotConfiguredError } from './zitadel-admin.client';

// Password resets are account administration. Reuse the existing role administration grant
// so existing deployments do not acquire a new grant implicitly.
const RESET_PERMISSION = 'admin.roles.write';

function canSendPasswordReset(): boolean {
  const caller = principal();
  return caller.orgKind === 'staff' && caller.grants.get(RESET_PERMISSION) === 'all';
}

// F1-Q5: deactivating and reactivating people is account administration too, so it takes the same Founder-only
// grant at company scope as password resets: no new permission, so no deployment gains it implicitly.
const STATUS_PERMISSION = 'admin.roles.write';

function canChangeStatus(): boolean {
  const caller = principal();
  return caller.orgKind === 'staff' && caller.grants.get(STATUS_PERMISSION) === 'all';
}

const Roles = z.array(RoleKeySchema).max(20);
const InviteBody = z.object({
  email: z.email().max(320),
  givenName: z.string().trim().min(1).max(200),
  familyName: z.string().trim().min(1).max(200),
  roles: Roles,
  /** F1-Q50: optional, both. Without them the person lands in no department at level staff, as before. */
  departmentId: z.guid().optional(),
  level: AccessLevelSchema.optional(),
});
const RolesBody = z.object({ roles: Roles });

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new BadRequestException(`Invalid ${what}: ${fields.join(', ')}`);
  }
  return parsed.data;
}

/** No provisioner token: the admin feature is off, which is the server's state, not the caller's fault. */
async function zitadelCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ZitadelNotConfiguredError) {
      throw new ServiceUnavailableException('User administration is not configured');
    }
    throw error;
  }
}

@Controller('v1/admin/users')
export class AdminUsersController {
  /**
   * Role and status writes re-read the caller's CURRENT roles inside their own transactions (U20b-Q3): the principal
   * comes from the sign-in token, so a person whose Founder role was taken away would otherwise keep granting roles,
   * Founder included, until the token expires. The roles are read from the mirror; the role -> permission table comes
   * from the role cache, which re-checks the authz version every 5 s.
   */
  private readonly liveGrants: LiveGrantDeps;

  constructor(
    private readonly users: UsersService,
    private readonly authz: AuthzService,
    store: UsersStore,
    roleCache: RoleCache,
    private readonly status: UserStatusService,
  ) {
    this.liveGrants = {
      users: store,
      grants: { grantsFor: (...args) => roleCache.grantsFor(...args) },
    };
  }

  /** X-Total-Count is every user matching the scope, filters and search, not just this page. */
  @Get()
  @Can('admin.users.read')
  async list(@Query() query: unknown, @Res({ passthrough: true }) res: HeaderTarget) {
    const q = parse(AdminUsersQuerySchema, query, 'query');
    const { scope } = requestTx();
    const { rows, total } = await this.users.list(scope, q);
    setTotalCount(res, total);
    const items = rows.slice(0, q.limit);
    const hasMore = rows.length > q.limit;
    const usingPages = q.page !== undefined || q.sort !== undefined;
    const page = q.page ?? 1;
    return {
      items,
      nextAfter: hasMore && !usingPages ? (items.at(-1)?.id ?? null) : null,
      nextPage: hasMore && usingPages && page < ADMIN_USERS_MAX_PAGE ? page + 1 : null,
    };
  }

  @Get('summary')
  @Can('admin.users.read')
  async summary() {
    const { scope } = requestTx();
    return {
      ...(await this.users.summary(scope)),
      canSendPasswordReset: canSendPasswordReset(),
      canChangeStatus: canChangeStatus(),
    };
  }

  /**
   * GET /v1/admin/users/identity-review: the people flagged for identity review and why (FU8). Read-only; it takes the
   * same company-wide grant as resolving a flag, so a caller who cannot resolve cannot list.
   */
  @Get('identity-review')
  @Can(STATUS_PERMISSION)
  async identityReview() {
    if (!canChangeStatus()) throw new ForbiddenException('Forbidden');
    const { scope } = requestTx();
    return { items: await this.users.listFlagged(scope) };
  }

  /**
   * POST /v1/admin/users/:id/deactivate, /reactivate, /lock and /unlock (F1-Q5, F1-Q4). 204 on success; 409 for the
   * caller's own account, the last Founder of an entity, a status or lock the action does not fit, a concurrent
   * change, or a change ZITADEL refused; 404 for anyone who is not a staff user of the tenant.
   */
  @Post(':id/deactivate')
  @HttpCode(204)
  @Can(STATUS_PERMISSION)
  deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.runStatusAction(id, 'deactivate');
  }

  @Post(':id/reactivate')
  @HttpCode(204)
  @Can(STATUS_PERMISSION)
  reactivate(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.runStatusAction(id, 'reactivate');
  }

  @Post(':id/lock')
  @HttpCode(204)
  @Can(STATUS_PERMISSION)
  lock(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.runStatusAction(id, 'lock');
  }

  @Post(':id/unlock')
  @HttpCode(204)
  @Can(STATUS_PERMISSION)
  unlock(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.runStatusAction(id, 'unlock');
  }

  /** Clears a flag set by a failed or ambiguous write to ZITADEL, after reading ZITADEL again. */
  @Post(':id/resolve-identity')
  @HttpCode(204)
  @Can(STATUS_PERMISSION)
  async resolveIdentity(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    if (!canChangeStatus()) throw new ForbiddenException('Forbidden');
    const { scope, actor } = requestTx();
    await zitadelCall(() =>
      this.users.resolveIdentityReview(scope, actor, id, async (tx) => {
        await assertLiveGrant(tx, this.liveGrants, scope, actor, STATUS_PERMISSION);
      }),
    );
    await this.authz.invalidate(scope.tenantId, scope.organizationId);
  }

  private async runStatusAction(id: string, action: UserStatusAction): Promise<void> {
    if (!canChangeStatus()) throw new ForbiddenException('Forbidden');
    const { scope, actor } = requestTx();
    await zitadelCall(() =>
      this.status.apply(scope, actor, id, action, async (tx) => {
        await assertLiveGrant(tx, this.liveGrants, scope, actor, STATUS_PERMISSION);
      }),
    );
    await this.authz.invalidate(scope.tenantId, scope.organizationId);
  }

  @Post(':id/password-reset')
  @HttpCode(204)
  @Can(RESET_PERMISSION)
  async sendPasswordReset(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    if (!canSendPasswordReset()) throw new ForbiddenException('Forbidden');
    const { scope, actor } = requestTx();
    await this.users.sendPasswordReset(scope, actor, id);
  }

  @Post('invite')
  @Can('admin.users.invite')
  async invite(@Body() body: unknown): Promise<{ userId: string }> {
    const { departmentId, level, ...invite } = parse(InviteBody, body, 'invite');
    const placement =
      departmentId !== undefined || (level !== undefined && level !== 'staff')
        ? { departmentId: departmentId ?? null, level: level ?? 'staff' }
        : null;
    // An invite grants roles, so it is a role assignment too: `admin.users.invite` alone must not be
    // a way to hand out `founder`. There is no default low role in the invite flow, so any role needs it.
    // A department or level shapes access the same way (D50), so it needs the same grant as a Departments save.
    const assignsAccess = invite.roles.length > 0 || placement !== null;
    if (assignsAccess) this.authz.assert('admin.roles.write');
    const { scope, actor } = requestTx();
    const invited = await zitadelCall(() =>
      this.users.invite(
        scope,
        actor,
        invite,
        placement,
        assignsAccess
          ? async (tx) => {
              await assertLiveGrant(tx, this.liveGrants, scope, actor, 'admin.roles.write');
            }
          : undefined,
      ),
    );
    if (assignsAccess) await this.authz.invalidate(scope.tenantId, scope.organizationId);
    return { userId: invited.userId };
  }

  @Put(':id/roles')
  @HttpCode(204)
  @Can('admin.roles.write')
  async setRoles(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    const { roles } = parse(RolesBody, body, 'roles');
    const { scope, actor } = requestTx();
    await zitadelCall(() =>
      this.users.setRoles(scope, actor, id, roles, async (tx) => {
        await assertLiveGrant(tx, this.liveGrants, scope, actor, 'admin.roles.write');
      }),
    );
    // After commit: a cache refilled before commit would read the old roles.
    await this.authz.invalidate(scope.tenantId, scope.organizationId);
  }
}
