// Admin routes for users: list, invite, set roles.
// Serves the NFR "role assignment has one source of truth": every change goes to ZITADEL first, then
// the mirror, then the authz cache is invalidated, so the token, the mirror and the cache agree.
import { ADMIN_USERS_MAX_PAGE, AdminUsersQuerySchema, RoleKeySchema } from '@bos/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
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
import { principal } from '../authz/principal';
import { DB, type Db } from '../db/db.module';
import { requestTx, withTx } from '../db/tx';
import { type HeaderTarget, setTotalCount } from '../list';
import { UsersService } from './users.service';
import { ZitadelNotConfiguredError } from './zitadel-admin.client';

// Password resets are account administration. Reuse the existing role administration grant
// so existing deployments do not acquire a new grant implicitly.
const RESET_PERMISSION = 'admin.roles.write';

function canSendPasswordReset(): boolean {
  const caller = principal();
  return caller.orgKind === 'staff' && caller.grants.get(RESET_PERMISSION) === 'all';
}

const Roles = z.array(RoleKeySchema).max(20);
const InviteBody = z.object({
  email: z.email().max(320),
  givenName: z.string().trim().min(1).max(200),
  familyName: z.string().trim().min(1).max(200),
  roles: Roles,
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
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly users: UsersService,
    private readonly authz: AuthzService,
  ) {}

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
    return { ...(await this.users.summary(scope)), canSendPasswordReset: canSendPasswordReset() };
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
    const b = parse(InviteBody, body, 'invite');
    // An invite grants roles, so it is a role assignment too: `admin.users.invite` alone must not be
    // a way to hand out `founder`. There is no default low role in the invite flow, so any role needs it.
    if (b.roles.length > 0) this.authz.assert('admin.roles.write');
    const { scope, actor } = requestTx();
    const result = await zitadelCall(() =>
      withTx(this.db, scope, actor, (tx) => this.users.invite(tx, b)),
    );
    if (b.roles.length > 0) await this.authz.invalidate(scope.tenantId, scope.organizationId);
    return result;
  }

  @Put(':id/roles')
  @HttpCode(204)
  @Can('admin.roles.write')
  async setRoles(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    const { roles } = parse(RolesBody, body, 'roles');
    const { scope, actor } = requestTx();
    await zitadelCall(() =>
      withTx(this.db, scope, actor, (tx) => this.users.setRoles(tx, id, roles)),
    );
    // After commit: a cache refilled before commit would read the old roles.
    await this.authz.invalidate(scope.tenantId, scope.organizationId);
  }
}
